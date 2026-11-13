import { describe, expect, it, vi } from 'vitest';
import { ConcurrencyError } from '../../src/documents/application/ports';
import { createHarness, type Harness } from './support/harness';

/** Submits the fixture; its `process` message is "lost" (the test never delivers it). */
const stuckDocument = async (h: Harness) => {
  const { documentId } = await h.submit();
  return { documentId, message: h.lastMessage() };
};

describe('RequeueDocumentHandler (in-memory adapters)', () => {
  it('requeues a Received document: event, read model and process message in one unit of work', async () => {
    const h = createHarness();
    const { documentId } = await stuckDocument(h);

    expect(
      await h.requeue({ documentId, reason: 'dlq-redrive', causationId: 'dead-letter-1' }),
    ).toEqual({ outcome: 'requeued', status: 'Received', attempt: 1 });

    const history = await h.events.load(documentId);
    expect(history.map((s) => s.event)).toEqual([
      expect.objectContaining({ type: 'DocumentReceived' }),
      {
        type: 'ProcessingRequeued',
        attempt: 1,
        reason: 'dlq-redrive',
        requeuedAt: expect.any(String),
      },
    ]);
    // Same correlation id as the document's intake, so its log lines can be followed end to end.
    expect(history[1]?.metadata).toEqual({
      correlationId: 'c-key-1',
      causationId: 'dead-letter-1',
      actor: 'dlq-redrive',
    });
    expect(await h.view(documentId)).toMatchObject({
      status: 'Received',
      version: 2,
      updatedAt: history[1]?.occurredAt,
    });
    expect(h.outboxMessages()).toHaveLength(2);
    expect(h.lastMessage()).toMatchObject({
      routingKey: 'process',
      payload: { documentId, attempt: 1 },
      headers: { 'x-correlation-id': 'c-key-1' },
    });

    // Only the relay publishes; the worker then processes the requeued message as usual.
    expect(await h.deliver(h.lastMessage())).toBe('completed');
  });

  it('attempt still in progress (the worker died, its message was dead-lettered): asks for the same attempt, which resumes', async () => {
    const h = createHarness();
    const { documentId, message } = await stuckDocument(h);
    vi.spyOn(h.rules, 'validate').mockRejectedValueOnce(new Error('worker crashed'));
    await expect(h.deliver(message)).rejects.toThrow('worker crashed');

    expect(await h.requeue({ documentId, reason: 'sweeper' })).toEqual({
      outcome: 'requeued',
      status: 'Processing',
      attempt: 1,
    });
    expect(await h.deliver(h.lastMessage())).toBe('completed');

    expect(await h.eventTypes(documentId)).toEqual([
      'DocumentReceived',
      'ProcessingStarted',
      'ProcessingRequeued',
      'DocumentProcessed',
    ]);
  });

  it('attempt ended (its retry message was lost): asks for the next attempt', async () => {
    const h = createHarness();
    h.vat.failNext = 1;
    const { documentId, message } = await stuckDocument(h);
    expect(await h.deliver(message)).toBe('retry-scheduled');

    expect(await h.requeue({ documentId, reason: 'dlq-redrive' })).toEqual({
      outcome: 'requeued',
      status: 'Processing',
      attempt: 2,
    });
    expect(await h.deliver(h.lastMessage())).toBe('completed');
    expect((await h.view(documentId))?.attempts).toBe(2);
  });

  it.each([
    ['Completed', () => undefined],
    ['Failed', (h: Harness) => h.vat.invalid.add('NL009876543B01')],
  ] as const)('a %s document is not touched: already-final', async (status, arrange) => {
    const h = createHarness();
    arrange(h);
    const { documentId, message } = await stuckDocument(h);
    await h.deliver(message);
    const events = await h.events.load(documentId);
    const view = await h.view(documentId);

    expect(await h.requeue({ documentId, reason: 'dlq-redrive' })).toEqual({
      outcome: 'already-final',
      status,
    });

    expect(await h.events.load(documentId)).toEqual(events);
    expect(await h.view(documentId)).toEqual(view);
    expect(h.outboxMessages()).toHaveLength(1);
  });

  it('an unknown document: not-found, nothing written', async () => {
    const h = createHarness();
    expect(await h.requeue({ documentId: 'unknown', reason: 'dlq-redrive' })).toEqual({
      outcome: 'not-found',
    });
    expect(h.outboxMessages()).toEqual([]);
  });

  it('writes nothing when the unit of work fails (the outbox write throws)', async () => {
    const h = createHarness();
    const { documentId } = await stuckDocument(h);
    const view = await h.view(documentId);
    vi.spyOn(h.outbox, 'enqueue').mockRejectedValueOnce(new Error('database down'));

    await expect(h.requeue({ documentId, reason: 'dlq-redrive' })).rejects.toThrow('database down');

    expect(await h.eventTypes(documentId)).toEqual(['DocumentReceived']);
    expect(await h.view(documentId)).toEqual(view);
    expect(h.outboxMessages()).toHaveLength(1);
  });

  it('concurrent requeues at the same expected version: exactly one wins', async () => {
    const h = createHarness();
    const { documentId } = await stuckDocument(h);
    const { version } = (await h.view(documentId))!;

    const results = await Promise.allSettled([
      h.requeue({ documentId, reason: 'sweeper', expectedVersion: version }),
      h.requeue({ documentId, reason: 'sweeper', expectedVersion: version }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(ConcurrencyError);
    expect(await h.eventTypes(documentId)).toEqual(['DocumentReceived', 'ProcessingRequeued']);
    expect(h.outboxMessages()).toHaveLength(2);
  });

  it('a document that moved on since it was found (stale expected version) is not requeued', async () => {
    const h = createHarness();
    const { documentId, message } = await stuckDocument(h);
    const { version } = (await h.view(documentId))!;
    // Meanwhile the worker picks the document up after all and dies mid-attempt.
    vi.spyOn(h.rules, 'validate').mockRejectedValueOnce(new Error('worker crashed'));
    await expect(h.deliver(message)).rejects.toThrow();

    await expect(
      h.requeue({ documentId, reason: 'sweeper', expectedVersion: version }),
    ).rejects.toBeInstanceOf(ConcurrencyError);

    expect(await h.eventTypes(documentId)).toEqual(['DocumentReceived', 'ProcessingStarted']);
    expect(h.outboxMessages()).toHaveLength(1);
  });

  it('dry run: reports the decision and writes nothing', async () => {
    const h = createHarness();
    const { documentId } = await stuckDocument(h);

    expect(await h.requeue({ documentId, reason: 'dlq-redrive', dryRun: true })).toEqual({
      outcome: 'requeued',
      status: 'Received',
      attempt: 1,
    });

    expect(await h.eventTypes(documentId)).toEqual(['DocumentReceived']);
    expect(h.outboxMessages()).toHaveLength(1);
  });
});
