import { randomUUID } from 'node:crypto';
import type { INestApplicationContext, Provider } from '@nestjs/common';
import { CommandHandler, CqrsModule, type ICommandHandler } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';
import { type Channel, type ChannelModel, connect } from 'amqplib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  messagingConsumers,
  RabbitMqDocumentConsumer,
} from '../../src/documents/adapters/inbound/messaging/rabbitmq-document-consumer';
import { AmqpConnection } from '../../src/documents/adapters/outbound/rabbitmq/amqp-connection';
import type { RabbitMqConfig } from '../../src/documents/adapters/outbound/rabbitmq/rabbitmq-config';
import { rabbitMqProviders } from '../../src/documents/adapters/outbound/rabbitmq/rabbitmq-providers';
import { RabbitMqPublisher } from '../../src/documents/adapters/outbound/rabbitmq/rabbitmq-publisher';
import {
  DELIVERY_LIMIT,
  type Topology,
  topologyFor,
} from '../../src/documents/adapters/outbound/rabbitmq/topology';
import {
  DeadLetterSource,
  DlqRedrive,
} from '../../src/documents/adapters/inbound/messaging/dlq-redrive';
import { RabbitMqDeadLetterSource } from '../../src/documents/adapters/inbound/messaging/rabbitmq-dead-letter-source';
import { ProcessDocumentCommand } from '../../src/documents/application/commands/process-document';
import {
  RequeueDocumentCommand,
  type RequeueResult,
} from '../../src/documents/application/commands/requeue-document';
import { MessagePublisher, PublishFailedError } from '../../src/documents/application/ports';
import {
  type DeliveredMessageView,
  describeMessagePublisherContract,
  type MessagingHarness,
} from '../contracts/message-publisher.contract';

// Same source as the Postgres contract tests: the environment (CI) or apps/service/.env (local),
// so a worktree with its own compose project never talks to another one's broker.
try {
  process.loadEnvFile('.env');
} catch {
  // No .env file: rely on the environment.
}

// Runs against the RabbitMQ from `pnpm infra:up`. Every suite declares its own topology under a
// random prefix and deletes it afterwards, so runs never see each other's messages.
const AMQP_URL = process.env['AMQP_URL'] ?? 'amqp://xip:xip@localhost:5672';
const RETRY_DELAY_MS = 300;

const testConfig = (): RabbitMqConfig => ({
  url: AMQP_URL,
  prefix: `test-${randomUUID().slice(0, 8)}.`,
  prefetch: 4,
  retryDelaysMs: [RETRY_DELAY_MS, RETRY_DELAY_MS * 2, RETRY_DELAY_MS * 3],
  requeueDelayMs: { base: 1, max: 20 },
});

/** A plain amqplib connection next to the adapters, to inspect and clean up the broker. */
async function openInspector(): Promise<{ channel: Channel; connection: ChannelModel }> {
  const connection = await connect(AMQP_URL);
  return { connection, channel: await connection.createChannel() };
}

async function deleteTopology(topology: Topology): Promise<void> {
  const { connection, channel } = await openInspector();
  try {
    const queues = [topology.processQueue, topology.deadLetterQueue];
    for (const queue of [...queues, ...topology.retryQueues.map((r) => r.queue)]) {
      await channel.deleteQueue(queue);
    }
    await channel.deleteExchange(topology.exchange);
    await channel.deleteExchange(topology.deadLetterExchange);
  } finally {
    await connection.close();
  }
}

async function eventually<T>(probe: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('Condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Fatal reasons are recorded instead of exiting the test process. */
function startAdapters(
  config: RabbitMqConfig,
  fatal: string[],
  providers: Provider[] = [],
): Promise<INestApplicationContext> {
  return Test.createTestingModule({
    imports: [CqrsModule.forRoot()],
    providers: [...rabbitMqProviders(config), ...providers],
  })
    .overrideProvider(AmqpConnection)
    .useFactory({ factory: () => new AmqpConnection(config, (reason) => fatal.push(reason)) })
    .compile()
    .then((module) => module.init());
}

describeMessagePublisherContract(
  'rabbitmq',
  async () => {
    const config = testConfig();
    const fatal: string[] = [];
    const app = await startAdapters(config, fatal);
    const publisher = app.get<MessagePublisher, RabbitMqPublisher>(MessagePublisher);
    await publisher.waitUntilConnected();

    // Reads the process queue the way the worker would, but hands the messages to the contract.
    const deliveries: DeliveredMessageView[] = [];
    const waiters: Array<(message: DeliveredMessageView) => void> = [];
    const connection = app.get(AmqpConnection);
    const reader = connection.createChannel('reader', false, async (channel) => {
      await channel.consume(connection.topology.processQueue, (message) => {
        if (!message) return;
        channel.ack(message);
        const view: DeliveredMessageView = {
          payload: JSON.parse(message.content.toString()),
          messageId: String(message.properties.messageId),
          headers: message.properties.headers ?? {},
        };
        const waiter = waiters.shift();
        if (waiter) waiter(view);
        else deliveries.push(view);
      });
    });
    await reader.waitForConnect();

    const harness: MessagingHarness = {
      publisher,
      nextProcessDelivery: (timeoutMs) =>
        new Promise((resolve, reject) => {
          const queued = deliveries.shift();
          if (queued) return resolve(queued);
          const timer = setTimeout(() => reject(new Error('no delivery')), timeoutMs);
          waiters.push((message) => {
            clearTimeout(timer);
            resolve(message);
          });
        }),
      // A publisher pointed at a closed port: never connected, so it must reject at once.
      simulateOutage: async () => {
        const unreachable = new AmqpConnection(
          { ...config, url: 'amqp://xip:xip@127.0.0.1:1' },
          (reason) => fatal.push(reason),
        );
        const outagePublisher = new RabbitMqPublisher(unreachable);
        harness.publisher = outagePublisher;
        return async () => {
          harness.publisher = publisher;
          await outagePublisher.onModuleDestroy();
          await unreachable.onApplicationShutdown();
        };
      },
      close: async () => {
        await reader.close();
        await app.close();
        await deleteTopology(topologyFor(config));
        expect(fatal).toEqual([]);
      },
    };
    return harness;
  },
  { retryDelayMs: RETRY_DELAY_MS },
);

describe('rabbitmq: publisher', () => {
  it('rejects within a second while it cannot reach the broker (no buffering, no 5 s wait)', async () => {
    const connection = new AmqpConnection(
      { ...testConfig(), url: 'amqp://xip:xip@127.0.0.1:1' },
      () => undefined,
    );
    const publisher = new RabbitMqPublisher(connection);
    try {
      const startedAt = Date.now();
      await expect(
        publisher.publish('process', {}, { messageId: randomUUID() }),
      ).rejects.toBeInstanceOf(PublishFailedError);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    } finally {
      await publisher.onModuleDestroy();
      await connection.onApplicationShutdown();
    }
  });
});

/** Records the commands the consumer dispatches; fails them while `failing` is set. */
class Recorder {
  readonly commands: ProcessDocumentCommand['input'][] = [];
  failing = false;
}

@CommandHandler(ProcessDocumentCommand)
class RecordingHandler implements ICommandHandler<ProcessDocumentCommand> {
  constructor(private readonly recorder: Recorder) {}

  async execute({ input }: ProcessDocumentCommand): Promise<string> {
    this.recorder.commands.push(input);
    if (this.recorder.failing) throw new Error('poison message');
    return 'completed';
  }
}

describe('rabbitmq: document consumer', () => {
  let config: RabbitMqConfig;
  let topology: Topology;
  let fatal: string[];
  let recorder: Recorder;
  let worker: INestApplicationContext | undefined;
  let inspector: { channel: Channel; connection: ChannelModel };

  const startWorker = async (): Promise<INestApplicationContext> => {
    worker = await startAdapters(config, fatal, [
      ...messagingConsumers,
      RecordingHandler,
      { provide: Recorder, useValue: recorder },
    ]);
    return worker;
  };

  const publish = (payload: Record<string, unknown>, messageId = randomUUID()) =>
    worker!.get(MessagePublisher).publish('process', payload, {
      messageId,
      headers: { 'x-correlation-id': 'corr-1' },
    });

  beforeAll(async () => {
    inspector = await openInspector();
  });

  afterAll(async () => {
    await inspector.connection.close();
  });

  beforeEach(() => {
    config = testConfig();
    topology = topologyFor(config);
    fatal = [];
    recorder = new Recorder();
  });

  afterEach(async () => {
    await worker?.close();
    worker = undefined;
    await deleteTopology(topology);
  });

  const ready = async (app: INestApplicationContext): Promise<void> => {
    await app.get(RabbitMqDocumentConsumer).waitUntilConsuming();
    await app.get<MessagePublisher, RabbitMqPublisher>(MessagePublisher).waitUntilConnected();
  };

  it('dispatches ProcessDocumentCommand and acks only after the handler resolved', async () => {
    const app = await startWorker();
    await ready(app);
    const messageId = randomUUID();
    await publish({ documentId: 'd-1', attempt: 1 }, messageId);

    await eventually(async () => recorder.commands[0]);
    expect(recorder.commands).toEqual([
      { documentId: 'd-1', attempt: 1, messageId, correlationId: 'corr-1' },
    ]);

    // After a graceful stop, nothing is left on the queue: the delivery was acked, not requeued.
    await app.close();
    worker = undefined;
    const { messageCount } = await inspector.channel.checkQueue(topology.processQueue);
    expect(messageCount).toBe(0);
    expect(fatal).toEqual([]);
  });

  it('rejects a failing message until the delivery limit dead-letters it to the DLQ', async () => {
    recorder.failing = true;
    const app = await startWorker();
    await ready(app);
    const messageId = randomUUID();
    await publish({ documentId: 'd-poison', attempt: 1 }, messageId);

    const dead = await eventually(async () => {
      const message = await inspector.channel.get(topology.deadLetterQueue, { noAck: true });
      return message || undefined;
    });
    expect(dead.properties.messageId).toBe(messageId);
    expect(dead.properties.headers?.['x-first-death-reason']).toBe('delivery_limit');
    expect(dead.properties.headers?.['x-first-death-queue']).toBe(topology.processQueue);
    // reject() counts toward x-delivery-limit: the first delivery plus DELIVERY_LIMIT redeliveries.
    // With nack() the message would loop forever and never reach the DLQ (spike 02b, T3).
    expect(recorder.commands).toHaveLength(DELIVERY_LIMIT + 1);
    expect((await inspector.channel.checkQueue(topology.processQueue)).messageCount).toBe(0);
    expect(fatal).toEqual([]);
  });

  it('fails fast when the broker cancels the consumer', async () => {
    const app = await startWorker();
    await ready(app);
    await inspector.channel.deleteQueue(topology.processQueue); // the broker sends basic.cancel

    const reason = await eventually(async () => fatal[0]);
    expect(reason).toMatch(/cancelled the document consumer/);
  });

  it('fails fast when the topology cannot be declared (queue exists with other arguments)', async () => {
    await inspector.channel.assertQueue(topology.processQueue, { durable: true }); // classic queue
    await startWorker();

    const reason = await eventually(async () => fatal[0]);
    expect(reason).toMatch(/PRECONDITION_FAILED/);
    expect(fatal).toHaveLength(1);
  });
});

/** Stands in for RequeueDocumentHandler: records the commands, fails for `failFor`. */
class RequeueRecorder {
  readonly documentIds: string[] = [];
  failFor = new Set<string>();
}

@CommandHandler(RequeueDocumentCommand)
class RecordingRequeueHandler implements ICommandHandler<RequeueDocumentCommand> {
  constructor(private readonly recorder: RequeueRecorder) {}

  async execute({ input }: RequeueDocumentCommand): Promise<RequeueResult> {
    this.recorder.documentIds.push(input.documentId);
    if (this.recorder.failFor.has(input.documentId)) throw new Error('database down');
    return { outcome: 'requeued', status: 'Processing', attempt: 2 };
  }
}

describe('rabbitmq: dead-letter source (xip redrive)', () => {
  let config: RabbitMqConfig;
  let fatal: string[];
  let connection: AmqpConnection;
  let source: RabbitMqDeadLetterSource;
  let inspector: { channel: Channel; connection: ChannelModel };

  beforeAll(async () => {
    inspector = await openInspector();
  });

  afterAll(async () => {
    await inspector.connection.close();
  });

  beforeEach(async () => {
    config = testConfig();
    fatal = [];
    connection = new AmqpConnection(config, (reason) => fatal.push(reason));
    source = new RabbitMqDeadLetterSource(connection);
    expect(await source.count()).toBe(0); // connected, topology declared
  });

  afterEach(async () => {
    await source.onModuleDestroy();
    await connection.onApplicationShutdown();
    await deleteTopology(topologyFor(config));
    expect(fatal).toEqual([]);
  });

  /** Puts a message straight into the DLQ, as the delivery limit would. */
  const deadLetter = (body: unknown, messageId = randomUUID()): string => {
    const content = typeof body === 'string' ? body : JSON.stringify(body);
    inspector.channel.sendToQueue(connection.topology.deadLetterQueue, Buffer.from(content), {
      messageId,
      persistent: true,
    });
    return messageId;
  };
  const dlqHolds = (count: number) =>
    eventually(async () => ((await source.count()) === count ? true : undefined));

  it('hands out each message once with its parsed body; ack removes it, release keeps it', async () => {
    const valid = deadLetter({ documentId: 'd-1', attempt: 1 });
    const garbage = deadLetter('not json');
    await dlqHolds(2);

    const first = await source.next();
    const second = await source.next();
    expect(first).toMatchObject({ messageId: valid, payload: { documentId: 'd-1', attempt: 1 } });
    expect(second).toMatchObject({ messageId: garbage, payload: undefined });
    expect(await source.next()).toBeUndefined(); // both taken, neither handed out again

    first!.ack();
    second!.release();
    await dlqHolds(1);
    expect((await source.next())?.messageId).toBe(garbage);
  });

  it('a released message stays, however often: release does not count toward the delivery limit', async () => {
    // The DLQ has no explicit limit, so RabbitMQ 4.4 applies the quorum default of 20 and drops
    // the message after that many returns: with basic.reject, or by closing the channel.
    const messageId = deadLetter({ documentId: 'd-1', attempt: 1 });
    await dlqHolds(1);

    for (let run = 0; run < 25; run++) {
      const letter = await eventually(() => source.next());
      expect(letter.messageId).toBe(messageId);
      letter.release();
    }

    await dlqHolds(1);
  });

  it('xip redrive acks only what was requeued and leaves malformed and failing messages', async () => {
    const recorder = new RequeueRecorder();
    recorder.failFor.add('d-fail');
    const app = await Test.createTestingModule({
      imports: [CqrsModule.forRoot()],
      providers: [
        DlqRedrive,
        RecordingRequeueHandler,
        { provide: RequeueRecorder, useValue: recorder },
        { provide: DeadLetterSource, useValue: source },
      ],
    })
      .compile()
      .then((module) => module.init());
    try {
      deadLetter({ documentId: 'd-ok', attempt: 1 });
      deadLetter({ documentId: 'd-fail', attempt: 1 });
      const malformed = deadLetter('{"attempt":1}');
      await dlqHolds(3);

      const report = await app.get(DlqRedrive).run({ dryRun: false });

      expect(report).toMatchObject({
        requeued: [{ documentId: 'd-ok' }],
        failed: ['d-fail'],
        malformed: [malformed],
      });
      expect(recorder.documentIds).toEqual(['d-ok', 'd-fail']);
      await dlqHolds(2);
    } finally {
      await app.close();
    }
  });
});
