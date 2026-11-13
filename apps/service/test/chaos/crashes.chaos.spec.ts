import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Api, clients } from '../e2e/support/stack';
import { compose, expectExactlyOnce, largeInvoice, restoreStack } from './support/chaos';

/**
 * Hard crashes of the worker and the broker against the full compose stack. `docker compose kill
 * -s KILL` on purpose: a graceful stop would let the process finish or hand back its work, which
 * is not what a crash looks like. Every scenario puts the stack back afterwards, also when it fails.
 */
describe('crashes (chaos)', () => {
  let supplier: Api;

  beforeAll(async () => {
    supplier = await Api.as(clients.supplier);
  });

  afterEach(restoreStack);

  it('resumes the attempt of a worker killed mid-attempt, without starting it twice', async () => {
    // ProcessingStarted commits before the Schematron run, which takes seconds on 300 lines.
    const documentId = await supplier.accepted(largeInvoice());
    await supplier.waitFor(documentId, (d) => d.attempts >= 1);
    await compose('kill', '-s', 'KILL', 'worker');

    const atKill = await supplier.history(documentId);
    expect(atKill.at(-1)?.type, 'killed mid-attempt').toBe('ProcessingStarted');
    const attempt = atKill.at(-1)!.event.attempt as number;

    // The killed worker's unacked delivery goes back to the queue; the new worker resumes the
    // attempt from it, without a second ProcessingStarted.
    await compose('start', 'worker');
    expect((await supplier.waitForFinal(documentId, 120_000)).status).toBe('Completed');
    const history = await expectExactlyOnce(supplier, documentId);
    const startsOfAttempt = history.filter(
      (entry) => entry.type === 'ProcessingStarted' && entry.event.attempt === attempt,
    );
    expect(startsOfAttempt).toHaveLength(1);
    expect(history.slice(atKill.length).map((entry) => entry.type)).not.toContain(
      'ProcessingRequeued',
    );
  });
});
