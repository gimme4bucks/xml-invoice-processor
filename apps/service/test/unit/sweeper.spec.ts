import { describe, expect, it } from 'vitest';
import { Clock } from '../../src/documents/application/ports';
import { StuckDocumentSweeper } from '../../src/documents/application/sweeper/stuck-document-sweeper';
import { createHarness, type Harness } from './support/harness';

const STUCK_AFTER_MS = 15 * 60_000;

/** Time stands still until a test moves it. */
class FakeClock extends Clock {
  constructor(private current = new Date(0)) {
    super();
  }
  now(): Date {
    return new Date(this.current);
  }
  set(date: Date): void {
    this.current = date;
  }
}

/**
 * A document whose process message was published and then lost (for example dead-lettered after
 * a long database outage): nothing is pending in the outbox, and nothing will happen by itself.
 */
const lostMessage = async (h: Harness) => {
  const { documentId } = await h.submit();
  await h.outbox.publishPending(10, async () => undefined);
  const { updatedAt } = (await h.view(documentId))!;
  return { documentId, updatedAt };
};

const sweeperFor = (h: Harness, clock: Clock) =>
  new StuckDocumentSweeper(h.views, h.requeueHandler, clock);

/** The clock `ms` after the document's last change. */
const after = (updatedAt: Date, ms: number) => new Date(updatedAt.getTime() + ms);

describe('StuckDocumentSweeper (in-memory adapters, fake clock)', () => {
  it('requeues a document unchanged for longer than the threshold, with reason sweeper', async () => {
    const h = createHarness();
    const { documentId, updatedAt } = await lostMessage(h);
    const clock = new FakeClock(after(updatedAt, STUCK_AFTER_MS + 1));

    expect(await sweeperFor(h, clock).sweepOnce({ stuckAfterMs: STUCK_AFTER_MS })).toEqual({
      requeued: [{ documentId, status: 'Received', attempt: 1, unchangedSince: updatedAt }],
      skipped: 0,
    });

    expect((await h.eventsOf(documentId)).at(-1)).toMatchObject({
      type: 'ProcessingRequeued',
      reason: 'sweeper',
      attempt: 1,
    });
    expect(h.lastMessage()).toMatchObject({ payload: { documentId, attempt: 1 } });
    expect(await h.deliver(h.lastMessage())).toBe('completed');
  });

  it('leaves a document alone that changed within the threshold', async () => {
    const h = createHarness();
    const { documentId, updatedAt } = await lostMessage(h);
    const clock = new FakeClock(after(updatedAt, STUCK_AFTER_MS));

    expect(await sweeperFor(h, clock).sweepOnce({ stuckAfterMs: STUCK_AFTER_MS })).toEqual({
      requeued: [],
      skipped: 0,
    });
    expect(await h.eventTypes(documentId)).toEqual(['DocumentReceived']);
  });

  it('leaves a document alone whose message still waits in the outbox (broker down)', async () => {
    const h = createHarness();
    const { documentId } = await h.submit();
    const { updatedAt } = (await h.view(documentId))!;
    const clock = new FakeClock(after(updatedAt, 10 * STUCK_AFTER_MS));

    expect(await sweeperFor(h, clock).sweepOnce({ stuckAfterMs: STUCK_AFTER_MS })).toEqual({
      requeued: [],
      skipped: 0,
    });
    expect(h.outboxMessages()).toHaveLength(1);
  });

  it('does not requeue the same document again on the next sweep', async () => {
    const h = createHarness();
    const { updatedAt } = await lostMessage(h);
    const sweeper = sweeperFor(h, new FakeClock(after(updatedAt, STUCK_AFTER_MS + 1)));
    expect((await sweeper.sweepOnce({ stuckAfterMs: STUCK_AFTER_MS })).requeued).toHaveLength(1);

    // The requeue is a change, and its message waits in the outbox.
    expect(await sweeper.sweepOnce({ stuckAfterMs: STUCK_AFTER_MS })).toEqual({
      requeued: [],
      skipped: 0,
    });
    expect(h.outboxMessages()).toHaveLength(2);
  });

  it('two workers sweeping at the same time requeue a document once', async () => {
    const h = createHarness();
    const { documentId, updatedAt } = await lostMessage(h);
    const clock = new FakeClock(after(updatedAt, STUCK_AFTER_MS + 1));

    const reports = await Promise.all([
      sweeperFor(h, clock).sweepOnce({ stuckAfterMs: STUCK_AFTER_MS }),
      sweeperFor(h, clock).sweepOnce({ stuckAfterMs: STUCK_AFTER_MS }),
    ]);

    expect(reports.flatMap((r) => r.requeued)).toHaveLength(1);
    expect(reports.map((r) => r.skipped).sort()).toEqual([0, 1]);
    expect(await h.eventTypes(documentId)).toEqual(['DocumentReceived', 'ProcessingRequeued']);
    expect(h.outboxMessages()).toHaveLength(2);
  });
});
