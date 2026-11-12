import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplicationContext } from '@nestjs/common';
import { CommandBus, CqrsModule } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createInMemoryAdapters, inMemoryProviders } from '../../src/app/adapters';
import {
  ProcessDocumentCommand,
  ProcessDocumentHandler,
  type ProcessOutcome,
} from '../../src/documents/application/commands/process-document';
import {
  SubmitDocumentCommand,
  SubmitDocumentHandler,
  type SubmitDocumentResult,
} from '../../src/documents/application/commands/submit-document';
import {
  EventStore,
  MessagePublisher,
  Outbox,
  type OutboxMessage,
  type PublishOptions,
  type Transaction,
} from '../../src/documents/application/ports';
import { OutboxRelay } from '../../src/documents/application/relay/outbox-relay';

/**
 * Crash between "broker confirmed" and "row marked published" (ADR 0004): the relay must publish
 * the row again, and the duplicate must not process the document twice. Deterministic: the relay
 * runs by hand, the broker is a recorder, and the crash is injected exactly once.
 */
interface Published {
  routingKey: string;
  payload: Record<string, unknown>;
  options: PublishOptions;
}

/** A broker that confirms every publish and remembers what it received. */
class RecordingPublisher extends MessagePublisher {
  readonly published: Published[] = [];

  async publish(
    routingKey: string,
    payload: Record<string, unknown>,
    options: PublishOptions,
  ): Promise<void> {
    this.published.push({ routingKey, payload: structuredClone(payload), options });
  }
}

/**
 * Fault injection: after the publish was confirmed, the relay "crashes" before the outbox row is
 * marked published. The row stays pending, exactly as when the process dies at that point.
 */
class CrashBeforeMarkingOutbox extends Outbox {
  crashes = 0;

  constructor(private readonly inner: Outbox) {
    super();
  }

  enqueue(messages: readonly OutboxMessage[], tx: Transaction): Promise<void> {
    return this.inner.enqueue(messages, tx);
  }

  publishPending(
    limit: number,
    publish: (message: OutboxMessage) => Promise<void>,
  ): Promise<{ published: number; failed: number }> {
    return this.inner.publishPending(limit, async (message) => {
      await publish(message);
      if (this.crashes > 0) {
        this.crashes--;
        throw new Error('crashed after the confirm, before marking the row published');
      }
    });
  }
}

/** What the RabbitMQ consumer turns a delivery into. */
const toCommand = ({ payload, options }: Published): ProcessDocumentCommand =>
  new ProcessDocumentCommand({
    documentId: String(payload['documentId']),
    attempt: Number(payload['attempt']),
    messageId: options.messageId,
    correlationId: options.headers?.['x-correlation-id'] ?? options.messageId,
  });

const fixture = readFileSync(join(__dirname, '../fixtures/invoice-minimal.xml'));

describe('outbox relay: crash after publishing, before marking the row', () => {
  let app: INestApplicationContext;
  let commands: CommandBus;
  let broker: RecordingPublisher;
  let outbox: CrashBeforeMarkingOutbox;
  let relay: OutboxRelay;

  beforeEach(async () => {
    const adapters = createInMemoryAdapters();
    const module = await Test.createTestingModule({
      imports: [CqrsModule.forRoot()],
      providers: [...inMemoryProviders(adapters), SubmitDocumentHandler, ProcessDocumentHandler],
    }).compile();
    app = await module.init();
    commands = app.get(CommandBus);
    broker = new RecordingPublisher();
    outbox = new CrashBeforeMarkingOutbox(app.get(Outbox));
    relay = new OutboxRelay(outbox, broker);
  });

  afterEach(async () => {
    await app.close();
  });

  const submit = (): Promise<SubmitDocumentResult> =>
    commands.execute(
      new SubmitDocumentCommand({
        organisationId: 'org-supplier',
        peppolId: '0106:11111111',
        clientId: 'client-1',
        idempotencyKey: 'key-relay',
        xml: fixture,
        correlationId: 'corr-relay',
      }),
    );

  const history = async (documentId: string): Promise<string[]> =>
    (await app.get(EventStore).load(documentId)).map((stored) => stored.event.type);

  /** Submits a document and lets the relay crash once before marking its outbox row. */
  const publishTwice = async (): Promise<string> => {
    const { documentId } = await submit();
    outbox.crashes = 1;

    expect(await relay.relayOnce()).toEqual({ published: 0, failed: 1 });
    expect(broker.published).toHaveLength(1); // the broker has it, but the row is still pending

    expect(await relay.relayOnce()).toEqual({ published: 1, failed: 0 });
    expect(await relay.relayOnce()).toEqual({ published: 0, failed: 0 });

    const [first, second] = broker.published;
    expect(broker.published).toHaveLength(2);
    expect(second).toEqual(first); // same messageId, so the duplicate is recognisable
    expect(first?.routingKey).toBe('process');
    return documentId;
  };

  it('publishes the message again, and the consumer processes the document once', async () => {
    const documentId = await publishTwice();

    const outcomes: ProcessOutcome[] = [];
    for (const delivery of broker.published) {
      outcomes.push(await commands.execute(toCommand(delivery)));
    }

    expect(outcomes).toEqual(['completed', 'skipped']);
    expect(await history(documentId)).toEqual([
      'DocumentReceived',
      'ProcessingStarted',
      'DocumentProcessed',
    ]);
  });

  it('also processes the document once when both copies are delivered concurrently', async () => {
    const documentId = await publishTwice();

    const outcomes: ProcessOutcome[] = await Promise.all(
      broker.published.map((delivery) => commands.execute(toCommand(delivery))),
    );

    expect(outcomes.sort()).toEqual(['completed', 'skipped']);
    expect(await history(documentId)).toEqual([
      'DocumentReceived',
      'ProcessingStarted',
      'DocumentProcessed',
    ]);
  });
});
