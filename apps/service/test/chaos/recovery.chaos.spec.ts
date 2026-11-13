import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Api, clients, freshVatNumber, invoice } from '../e2e/support/stack';
import {
  broker,
  compose,
  database,
  expectExactlyOnce,
  infra,
  redrive,
  requeues,
  restoreStack,
  waitUntil,
} from './support/chaos';

/**
 * The recovery paths of ADR 0014 against the full compose stack: documents whose messages died in
 * the DLQ or disappeared reach their final state anyway, through `xip redrive` or the sweeper, and
 * are processed exactly once. Every scenario puts the stack back afterwards, also when it fails.
 */
describe('recovering stuck documents (chaos)', () => {
  let supplier: Api;

  beforeAll(async () => {
    supplier = await Api.as(clients.supplier);
    // The assertions count the DLQ's messages; leftovers from elsewhere would make them lie.
    expect(await broker.depth(infra.queues.dlq), 'documents.dlq must be empty').toBe(0);
  });

  afterEach(restoreStack);

  /**
   * Freezes the worker at a moment when every message of these documents is in RabbitMQ (queued,
   * waiting in a delay queue or held by the worker) and none waits in the outbox: only those can be
   * dead-lettered. The relay publishes within a fraction of a second, so this rarely loops.
   */
  async function freezeWorkerWithMessagesInBroker(documentIds: string[]): Promise<void> {
    await waitUntil(
      'a moment with no unpublished outbox row for these documents',
      async () => {
        await compose('pause', 'worker');
        if ((await database.unpublishedOutboxRows(documentIds)) === 0) return true;
        await compose('unpause', 'worker');
        return false;
      },
      30_000,
      100,
    );
  }

  it(
    'redrives the documents dead-lettered during a long PostgreSQL outage',
    async () => {
      // Each has VIES retries to come (a fresh VAT number fails twice), so its messages keep flowing.
      const documentIds = await Promise.all(
        [1, 2, 3].map(() =>
          supplier.accepted(invoice('valid-sales', { customerVat: freshVatNumber() })),
        ),
      );
      for (const id of documentIds) await supplier.waitFor(id, (d) => d.attempts >= 1);

      await freezeWorkerWithMessagesInBroker(documentIds);
      for (const id of documentIds) expect((await supplier.document(id)).status).toBe('Processing');
      await compose('pause', 'postgres'); // frozen: connections hang instead of being refused
      await compose('unpause', 'worker');

      // Every delivery now fails and is requeued with a back-off (1 s doubling to 30 s) until the
      // delivery limit (10) dead-letters it: a few minutes.
      await waitUntil(
        'the three messages in documents.dlq',
        async () => (await broker.depth(infra.queues.dlq)) >= 3,
        6 * 60_000,
        2_000,
      );
      // Postgres comes back with the worker held down: its sweeper would requeue the documents too
      // (they are long unchanged), and this scenario is about the redrive.
      await compose('kill', '-s', 'SIGKILL', 'worker');
      await compose('unpause', 'postgres');
      expect(await broker.depth(infra.queues.dlq)).toBe(3);

      const dryRun = await redrive('--dry-run');
      expect(dryRun.exitCode).toBe(0);
      expect(dryRun.summary.requeued.map((r) => r.documentId).sort()).toEqual(
        [...documentIds].sort(),
      );
      expect(await broker.depth(infra.queues.dlq), 'a dry run changes nothing').toBe(3);

      const { exitCode, summary } = await redrive();
      expect(exitCode).toBe(0);
      expect(summary.counts).toMatchObject({ requeued: 3, leftInDlq: 0 });
      expect(await broker.depth(infra.queues.dlq)).toBe(0);

      await compose('start', 'worker');
      for (const id of documentIds) {
        expect((await supplier.waitForFinal(id, 120_000)).status).toBe('Completed');
        const history = await expectExactlyOnce(supplier, id);
        expect(requeues(history).map((r) => r.reason)).toEqual(['dlq-redrive']);
      }
    },
    10 * 60_000,
  );
});
