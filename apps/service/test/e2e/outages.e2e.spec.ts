import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { Api, clients, compose, expectBody, freshVatNumber, invoice } from './support/stack';

/**
 * Infrastructure outages against the full compose stack: the broker, the database and the object
 * store (ADR 0016). `docker kill -s KILL` and `docker pause`
 * are used on purpose: a graceful stop or restart would let the broker and the database close
 * their connections cleanly, which is not what a crash or a hang looks like. Every test restores
 * the container in `finally`, so a failing assertion does not take the stack down for the rest.
 */
describe('outages (e2e)', () => {
  let supplier: Api;

  beforeAll(async () => {
    supplier = await Api.as(clients.supplier);
  });

  /**
   * A document the worker has started on, with its VIES retries still to come. Where the outage
   * catches it (its next message in the outbox, in a delay queue, or in the worker's hands) is up
   * to timing; the assertion is the invariant that holds for every case: processed exactly once.
   */
  async function inFlight(): Promise<string> {
    const documentId = await supplier.accepted(
      invoice('valid-sales', { customerVat: freshVatNumber() }),
    );
    await supplier.waitFor(documentId, (document) => document.attempts >= 1);
    return documentId;
  }

  it('accepts documents while RabbitMQ is down and completes them after its restart', async () => {
    const interrupted = await inFlight();
    const xml = invoice('valid-sales', { customerVat: freshVatNumber() });
    await compose('kill', '-s', 'SIGKILL', 'rabbitmq');
    const documentId = await (async () => {
      try {
        // Intake only needs Postgres: the document and its outbox message commit together.
        const id = await supplier.accepted(xml);
        expect((await supplier.document(id)).status).toBe('Received'); // nothing can take it yet
        return id;
      } finally {
        await compose('start', 'rabbitmq');
      }
    })();

    // The relay publishes the waiting outbox messages once the worker has reconnected; quorum
    // queues kept what was already published. Redeliveries are absorbed by the handler.
    for (const id of [documentId, interrupted]) {
      expect((await supplier.waitForFinal(id, 120_000)).status).toBe('Completed');
      await supplier.expectProcessedOnce(id);
    }
  });

  it('answers 503 while Postgres is down; a retry with the same key yields one document', async () => {
    // While the database is frozen the worker can neither relay nor record an attempt: a delivery
    // fails with PersistenceUnavailableError and is requeued (never acked) with a back-off.
    const interrupted = await inFlight();
    const key = randomUUID();
    const xml = invoice('valid-sales', { customerVat: freshVatNumber() });

    await compose('pause', 'postgres'); // frozen: connections hang instead of being refused
    try {
      const started = Date.now();
      const refused = await supplier.submit(xml, key);
      expect(expectBody(refused, 503).code).toBe('SERVICE_UNAVAILABLE');
      expect(refused.headers.get('retry-after')).toMatch(/^\d+$/);
      const read = await supplier.get(`/documents/${randomUUID()}`);
      expect(expectBody(read, 503).code).toBe('SERVICE_UNAVAILABLE');
      // Bounded by the adapter's timeouts, not by the length of the outage.
      expect(Date.now() - started).toBeLessThan(25_000);
    } finally {
      await compose('unpause', 'postgres');
    }

    // The client retries with the same key and body, as Retry-After tells it to.
    const documentId = await supplier.accepted(xml, key);
    const replayed = await supplier.submit(xml, key);
    expect(expectBody(replayed, 202)).toMatchObject({ documentId });
    // One document holds this content: the same file under a new key points at it.
    const duplicate = await supplier.submit(xml, randomUUID());
    expect(expectBody(duplicate, 409)).toMatchObject({ existingDocumentId: documentId });

    for (const id of [documentId, interrupted]) {
      expect((await supplier.waitForFinal(id, 120_000)).status).toBe('Completed');
      await supplier.expectProcessedOnce(id);
    }
  });

  it('answers 503 while the object store is down; a retry with the same key yields one document', async () => {
    // While the object store is frozen the API cannot upload a new document, and the worker cannot
    // read the original of one it has started on: that delivery fails with
    // PersistenceUnavailableError and is requeued (never acked) with a back-off.
    const interrupted = await inFlight();
    const key = randomUUID();
    const xml = invoice('valid-sales', { customerVat: freshVatNumber() });

    await compose('pause', 's3'); // frozen: requests hang instead of being refused
    try {
      const started = Date.now();
      const refused = await supplier.submit(xml, key);
      expect(expectBody(refused, 503).code).toBe('SERVICE_UNAVAILABLE');
      expect(refused.headers.get('retry-after')).toMatch(/^\d+$/);
      // Bounded by the adapter's deadline (S3_TIMEOUT_MS), not by the length of the outage.
      expect(Date.now() - started).toBeLessThan(15_000);
      // The status lives in Postgres: clients can still follow their documents.
      expect((await supplier.document(interrupted)).documentId).toBe(interrupted);
    } finally {
      await compose('unpause', 's3');
    }

    // The client retries with the same key and body, as Retry-After tells it to. The upload of the
    // refused attempt may have landed without a reference; the retry writes the same object again.
    const documentId = await supplier.accepted(xml, key);
    const replayed = await supplier.submit(xml, key);
    expect(expectBody(replayed, 202)).toMatchObject({ documentId });
    const duplicate = await supplier.submit(xml, randomUUID());
    expect(expectBody(duplicate, 409)).toMatchObject({ existingDocumentId: documentId });

    for (const id of [documentId, interrupted]) {
      expect((await supplier.waitForFinal(id, 120_000)).status).toBe('Completed');
      await supplier.expectProcessedOnce(id);
    }
    // The result, too, comes from the object store.
    expect((await supplier.result(documentId)).status).toBe('Completed');
  });
});
