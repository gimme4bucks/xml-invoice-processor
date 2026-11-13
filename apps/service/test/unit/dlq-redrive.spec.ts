import type { CommandBus } from '@nestjs/cqrs';
import { describe, expect, it, vi } from 'vitest';
import { redriveProviders } from '../../src/app/adapters';
import {
  type DeadLetter,
  DeadLetterSource,
  DlqRedrive,
  leftInDlq,
  parseRedriveArgs,
  type RedriveReport,
  redriveExitCode,
  redriveSummary,
} from '../../src/documents/adapters/inbound/messaging/dlq-redrive';
import { loadConfig } from '../../src/shared/config';
import type { RequeueDocumentCommand } from '../../src/documents/application/commands/requeue-document';
import type { OutboxMessage } from '../../src/documents/application/ports';
import { createHarness, type Harness, invoice } from './support/harness';

/**
 * A dead-letter queue in memory, behaving like RabbitMQ's basic.get: a taken message is not handed
 * out again until it is released, and `onAck` sees the database at the moment of the ack.
 */
class FakeDlq extends DeadLetterSource {
  readonly queue: Array<{ messageId: string; payload: unknown }> = [];
  readonly taken: string[] = [];
  readonly acked: string[] = [];
  onAck: (messageId: string) => void = () => undefined;

  add(...messages: Array<{ messageId: string; payload: unknown }>): this {
    this.queue.push(...messages);
    return this;
  }

  async count(): Promise<number> {
    return this.queue.length;
  }

  async next(): Promise<DeadLetter | undefined> {
    const message = this.queue.shift();
    if (!message) return undefined;
    this.taken.push(message.messageId);
    let settled = false;
    const settle = () => {
      if (settled) throw new Error(`${message.messageId} settled twice`);
      settled = true;
    };
    return {
      ...message,
      ack: () => {
        settle();
        this.onAck(message.messageId);
        this.acked.push(message.messageId);
      },
      release: () => {
        settle();
        this.queue.push(message);
      },
    };
  }

  ids(): string[] {
    return this.queue.map((m) => m.messageId);
  }
}

/** The DLQ copy of an outbox message, as the delivery limit left it there. */
const deadLetter = (message: OutboxMessage) => ({
  messageId: message.id,
  payload: message.payload,
});

const redriveFor = (h: Harness, dlq: FakeDlq) =>
  new DlqRedrive(dlq, {
    execute: (command: RequeueDocumentCommand) => h.requeueHandler.execute(command),
  } as unknown as CommandBus);

/** A document whose `process` message ended in the DLQ. */
const deadLettered = async (h: Harness, key: string) => {
  const { documentId } = await h.submit({ key, xml: invoice(`INV-${key}`) });
  return { documentId, letter: deadLetter(h.lastMessage()) };
};

const requeuedIn = (h: Harness, documentId: string) =>
  h.db.tables.events.some(
    (e) => e.streamId === documentId && e.event.type === 'ProcessingRequeued',
  );

describe('DLQ re-drive (in-memory adapters, fake DLQ)', () => {
  it('requeues the document of each message and acks it only after the requeue committed', async () => {
    const h = createHarness();
    const a = await deadLettered(h, 'a');
    const b = await deadLettered(h, 'b');
    const dlq = new FakeDlq().add(a.letter, b.letter);
    const committedAtAck: boolean[] = [];
    const documentOf = new Map([
      [a.letter.messageId, a.documentId],
      [b.letter.messageId, b.documentId],
    ]);
    dlq.onAck = (messageId) => committedAtAck.push(requeuedIn(h, documentOf.get(messageId)!));

    const report = await redriveFor(h, dlq).run({ dryRun: false });

    expect(report).toEqual({
      dryRun: false,
      requeued: [
        { documentId: a.documentId, status: 'Received', attempt: 1 },
        { documentId: b.documentId, status: 'Received', attempt: 1 },
      ],
      alreadyFinal: [],
      notFound: [],
      failed: [],
      malformed: [],
    });
    expect(committedAtAck).toEqual([true, true]);
    expect(dlq.ids()).toEqual([]);
    expect(leftInDlq(report)).toBe(0);
    // Through the outbox: the relay publishes the new messages, and the worker completes them.
    const requeued = h.outboxMessages().slice(-2);
    expect(requeued.map((m) => m.payload)).toEqual([
      { documentId: a.documentId, attempt: 1 },
      { documentId: b.documentId, attempt: 1 },
    ]);
    expect(await h.deliver(requeued[0]!)).toBe('completed');
    // The dead-lettered message is recorded as the cause of the requeue.
    const requeue = (await h.events.load(a.documentId)).find(
      (stored) => stored.event.type === 'ProcessingRequeued',
    );
    expect(requeue?.metadata.causationId).toBe(a.letter.messageId);
  });

  it('leaves the message in the DLQ when the requeue fails (the database is down)', async () => {
    const h = createHarness();
    const { documentId, letter } = await deadLettered(h, 'a');
    const dlq = new FakeDlq().add(letter);
    vi.spyOn(h.outbox, 'enqueue').mockRejectedValueOnce(new Error('database down'));

    const report = await redriveFor(h, dlq).run({ dryRun: false });

    expect(report.failed).toEqual([documentId]);
    expect(dlq.acked).toEqual([]);
    expect(dlq.ids()).toEqual([letter.messageId]);
    expect(requeuedIn(h, documentId)).toBe(false);
    expect(leftInDlq(report)).toBe(1);
  });

  it('leaves malformed messages in the DLQ and takes each message at most once per run', async () => {
    const h = createHarness();
    const { letter } = await deadLettered(h, 'a');
    const dlq = new FakeDlq().add(
      { messageId: 'not-json', payload: undefined },
      { messageId: 'no-document-id', payload: { attempt: 1 } },
      letter,
    );

    const report = await redriveFor(h, dlq).run({ dryRun: false });

    expect(report.malformed).toEqual(['not-json', 'no-document-id']);
    expect(report.requeued).toHaveLength(1);
    expect(dlq.taken).toEqual(['not-json', 'no-document-id', letter.messageId]);
    expect(dlq.ids()).toEqual(['not-json', 'no-document-id']);
    expect(leftInDlq(report)).toBe(2);
  });

  it('acks and reports messages for documents that are already final', async () => {
    const h = createHarness();
    const { documentId, letter } = await deadLettered(h, 'a');
    expect(await h.deliver(h.lastMessage())).toBe('completed'); // e.g. a duplicate got through
    const dlq = new FakeDlq().add(letter);

    const report = await redriveFor(h, dlq).run({ dryRun: false });

    expect(report.alreadyFinal).toEqual([{ documentId, status: 'Completed' }]);
    expect(dlq.acked).toEqual([letter.messageId]);
    expect(requeuedIn(h, documentId)).toBe(false);
    expect(leftInDlq(report)).toBe(0);
  });

  it('leaves messages for unknown documents in the DLQ and reports them', async () => {
    const h = createHarness();
    const dlq = new FakeDlq().add({
      messageId: 'm-1',
      payload: { documentId: 'gone', attempt: 1 },
    });

    const report = await redriveFor(h, dlq).run({ dryRun: false });

    expect(report.notFound).toEqual(['gone']);
    expect(dlq.ids()).toEqual(['m-1']);
    expect(leftInDlq(report)).toBe(1);
  });

  it('dry run: lists document ids and their status, and changes nothing', async () => {
    const h = createHarness();
    const stuck = await deadLettered(h, 'a');
    const final = await deadLettered(h, 'b');
    await h.deliver(h.lastMessage());
    const dlq = new FakeDlq().add(stuck.letter, final.letter);
    const outbox = h.outboxMessages().length;

    const report = await redriveFor(h, dlq).run({ dryRun: true });

    expect(report).toMatchObject({
      dryRun: true,
      requeued: [{ documentId: stuck.documentId, status: 'Received', attempt: 1 }],
      alreadyFinal: [{ documentId: final.documentId, status: 'Completed' }],
    });
    expect(dlq.acked).toEqual([]);
    expect(dlq.ids()).toEqual([stuck.letter.messageId, final.letter.messageId]);
    expect(requeuedIn(h, stuck.documentId)).toBe(false);
    expect(h.outboxMessages()).toHaveLength(outbox);
  });

  it('handles at most --limit messages', async () => {
    const h = createHarness();
    const letters = [await deadLettered(h, 'a'), await deadLettered(h, 'b')];
    const dlq = new FakeDlq().add(...letters.map((l) => l.letter));

    const report = await redriveFor(h, dlq).run({ dryRun: false, limit: 1 });

    expect(report.requeued.map((r) => r.documentId)).toEqual([letters[0]!.documentId]);
    expect(dlq.ids()).toEqual([letters[1]!.letter.messageId]);
  });

  it('handles at most the messages that were in the DLQ when it started', async () => {
    const h = createHarness();
    const first = await deadLettered(h, 'a');
    const later = await deadLettered(h, 'b');
    const dlq = new FakeDlq().add(first.letter);
    dlq.onAck = () => dlq.add(later.letter); // dead-lettered again while the run is going on

    const report = await redriveFor(h, dlq).run({ dryRun: false });

    expect(report.requeued.map((r) => r.documentId)).toEqual([first.documentId]);
    expect(dlq.ids()).toEqual([later.letter.messageId]);
  });
});

describe('xip redrive arguments', () => {
  it.each([
    [[], { dryRun: false }],
    [['--dry-run'], { dryRun: true }],
    [['--limit', '5'], { dryRun: false, limit: 5 }],
    [['--dry-run', '--limit=20'], { dryRun: true, limit: 20 }],
  ])('%j → %j', (args, expected) => {
    expect(parseRedriveArgs(args)).toEqual(expected);
  });

  it.each([[['--limit', '0']], [['--limit', 'all']], [['--force']]])('refuses %j', (args) => {
    expect(() => parseRedriveArgs(args)).toThrow(/Usage: xip redrive/);
  });
});

describe('xip redrive output', () => {
  const report: RedriveReport = {
    dryRun: false,
    requeued: [{ documentId: 'd-1', status: 'Processing', attempt: 2 }],
    alreadyFinal: [{ documentId: 'd-2', status: 'Completed' }],
    notFound: ['d-3'],
    failed: [],
    malformed: ['m-4'],
  };

  it('summarises counts and IDs only', () => {
    expect(redriveSummary(report)).toEqual({
      dryRun: false,
      counts: { requeued: 1, alreadyFinal: 1, notFound: 1, failed: 0, malformed: 1, leftInDlq: 2 },
      requeued: report.requeued,
      alreadyFinal: report.alreadyFinal,
      notFound: ['d-3'],
      failed: [],
      malformed: ['m-4'],
    });
  });

  it('exits non-zero when something stayed behind in the DLQ', () => {
    expect(redriveExitCode(report)).toBe(1);
    expect(redriveExitCode({ ...report, notFound: [], malformed: [] })).toBe(0);
  });

  it('a dry run leaves everything by design and exits 0', () => {
    expect(redriveExitCode({ ...report, dryRun: true })).toBe(0);
  });

  it('needs the real adapters, Postgres and RabbitMQ', () => {
    const real = { ADAPTERS: 'real', DATABASE_URL: 'postgresql://x', AMQP_URL: 'amqp://x' };
    expect(() => redriveProviders(loadConfig({ ...real, ADAPTERS: 'in-memory' }))).toThrow(
      /ADAPTERS=real/,
    );
    expect(() => redriveProviders(loadConfig({ ...real, AMQP_URL: undefined }))).toThrow(
      /AMQP_URL/,
    );
    expect(() => redriveProviders(loadConfig({ ...real, DATABASE_URL: undefined }))).toThrow(
      /DATABASE_URL/,
    );
    expect(redriveProviders(loadConfig(real), real).length).toBeGreaterThan(0);
  });
});
