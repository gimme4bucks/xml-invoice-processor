import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  DocumentRejectedError,
  IdempotencyConflictError,
  NotAPartyError,
} from '../../src/documents/application/errors';
import { IdempotencyRaceError } from '../../src/documents/application/ports';
import { DomainError } from '../../src/documents/domain/errors';
import {
  createHarness,
  customer,
  fixture,
  type Harness,
  invoice,
  type Organisation,
  supplier,
} from './support/harness';

const nothingStored = {
  events: [],
  views: new Map(),
  blobs: new Map(),
  outbox: [],
  idempotency: [],
};

const rejectionOf = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => {
      throw new Error('Expected a rejection');
    },
    (error: unknown) => error,
  );

describe('SubmitDocumentHandler (in-memory adapters)', () => {
  it('happy path: event, original XML, read model, idempotency record and one process message', async () => {
    const h = createHarness();
    const { documentId, replayed } = await h.submit();
    expect(replayed).toBe(false);

    const contentHash = createHash('sha256').update(fixture).digest('hex');
    const [stored] = await h.events.load(documentId);
    expect(stored).toMatchObject({
      version: 1,
      event: {
        type: 'DocumentReceived',
        documentId,
        organisationId: 'org-supplier',
        idempotencyKey: 'key-1',
        contentHash,
        documentType: 'Invoice',
        direction: 'sales',
      },
      metadata: { correlationId: 'c-key-1', actor: 'client-supplier' },
    });
    expect(await h.view(documentId)).toMatchObject({
      status: 'Received',
      direction: 'sales',
      attempts: 0,
      version: 1,
    });
    const original = await h.blobs.get(`documents/${documentId}/original.xml`);
    expect(original?.content.equals(fixture)).toBe(true);
    expect(h.db.tables.idempotency).toEqual([
      { organisationId: 'org-supplier', idempotencyKey: 'key-1', contentHash, documentId },
    ]);
    expect(h.outboxMessages()).toEqual([
      {
        id: expect.any(String),
        routingKey: 'process',
        payload: { documentId, attempt: 1 },
        headers: { 'x-correlation-id': 'c-key-1' },
      },
    ]);
  });

  it('the customer submitting the same file gets its own purchase document', async () => {
    const h = createHarness();
    const sales = await h.submit({ org: supplier });
    const purchase = await h.submit({ org: customer });
    expect(purchase).toEqual({ documentId: expect.any(String), replayed: false });
    expect(purchase.documentId).not.toBe(sales.documentId);
    expect(await h.view(purchase.documentId, customer)).toMatchObject({ direction: 'purchase' });
  });

  it('replay: the same key and content return the same document and store nothing new', async () => {
    const h = createHarness();
    const first = await h.submit();
    expect(await h.submit()).toEqual({ documentId: first.documentId, replayed: true });
    expect(h.db.tables.events).toHaveLength(1);
    expect(h.outboxMessages()).toHaveLength(1);
  });

  it('key reused with other content: IdempotencyConflictError key-reused (409)', async () => {
    const h = createHarness();
    const first = await h.submit();
    const error = await rejectionOf(h.submit({ xml: invoice('INV-OTHER') }));
    expect(error).toBeInstanceOf(IdempotencyConflictError);
    expect(error).toMatchObject({ conflict: 'key-reused', existingDocumentId: first.documentId });
    expect(h.db.tables.events).toHaveLength(1);
    expect(h.outboxMessages()).toHaveLength(1);
  });

  it('duplicate content under a new key: IdempotencyConflictError duplicate-content (409)', async () => {
    const h = createHarness();
    const first = await h.submit({ key: 'key-1' });
    const error = await rejectionOf(h.submit({ key: 'key-2' }));
    expect(error).toBeInstanceOf(IdempotencyConflictError);
    expect(error).toMatchObject({
      conflict: 'duplicate-content',
      existingDocumentId: first.documentId,
    });
    expect(h.db.tables.events).toHaveLength(1);
    expect(h.db.tables.idempotency).toHaveLength(1);
  });

  it('organisation not a party to the invoice: NotAPartyError, nothing stored', async () => {
    const h = createHarness();
    const outsider = { organisationId: 'org-x', peppolId: '0106:33333333', clientId: 'client-x' };
    await expect(h.submit({ org: outsider })).rejects.toBeInstanceOf(NotAPartyError);
    expect(h.db.tables).toEqual(nothingStored);
  });

  it('structurally invalid document: DocumentRejectedError, nothing stored', async () => {
    const h = createHarness();
    const xml = Buffer.from(
      `<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>${fixture.toString()}`,
    );
    const error = await rejectionOf(h.submit({ xml }));
    expect(error).toBeInstanceOf(DocumentRejectedError);
    expect(error).toMatchObject({ reason: 'doctype-forbidden' });
    expect(h.db.tables).toEqual(nothingStored);
  });

  it.each<[string, string, { org?: Organisation; key?: string }]>([
    [
      'an empty organisation id',
      'INVALID_ORGANISATION_ID',
      { org: { ...supplier, organisationId: ' ' } },
    ],
    ['an empty Idempotency-Key', 'INVALID_IDEMPOTENCY_KEY', { key: '' }],
    ['a 256-character Idempotency-Key', 'INVALID_IDEMPOTENCY_KEY', { key: 'k'.repeat(256) }],
    ['an Idempotency-Key with a newline', 'INVALID_IDEMPOTENCY_KEY', { key: 'key\n1' }],
    [
      'a malformed Peppol id',
      'INVALID_PEPPOL_ID',
      { org: { ...supplier, peppolId: 'KVK-11111111' } },
    ],
  ])('invalid input (%s): DomainError %s before any other work', async (_name, code, input) => {
    const h = createHarness();
    const validate = vi.spyOn(h.structure, 'validate');
    const error = await rejectionOf(h.submit(input));
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({ code });
    expect(validate).not.toHaveBeenCalled();
    expect(h.db.tables).toEqual(nothingStored);
  });

  describe('race on the idempotency registry', () => {
    it('a concurrent request won the unique index: the handler retries once and replays its document', async () => {
      const h = createHarness();
      const winner = await h.submit();
      // Our request passed the check before the winner committed; the unique index then
      // rejects its insert, which the adapter reports as IdempotencyRaceError.
      const register = vi
        .spyOn(h.idempotency, 'register')
        .mockRejectedValueOnce(new IdempotencyRaceError());
      expect(await h.submit()).toEqual({ documentId: winner.documentId, replayed: true });
      expect(register).toHaveBeenCalledTimes(2);
      expect(h.db.tables.events).toHaveLength(1);
      expect(h.outboxMessages()).toHaveLength(1);
    });

    it('the retry races again: no third try, the IdempotencyRaceError propagates', async () => {
      const h = createHarness();
      const register = vi
        .spyOn(h.idempotency, 'register')
        .mockRejectedValue(new IdempotencyRaceError());
      await expect(h.submit()).rejects.toBeInstanceOf(IdempotencyRaceError);
      expect(register).toHaveBeenCalledTimes(2);
      expect(h.db.tables).toEqual(nothingStored);
    });
  });

  describe('atomicity: everything in one unit of work', () => {
    const failingWrites: Array<[string, (h: Harness, error: Error) => void]> = [
      [
        'idempotency.register',
        (h, e) => void vi.spyOn(h.idempotency, 'register').mockRejectedValueOnce(e),
      ],
      ['events.append', (h, e) => void vi.spyOn(h.events, 'append').mockRejectedValueOnce(e)],
      ['blobs.put', (h, e) => void vi.spyOn(h.blobs, 'put').mockRejectedValueOnce(e)],
      ['views.upsert', (h, e) => void vi.spyOn(h.views, 'upsert').mockRejectedValueOnce(e)],
      ['outbox.enqueue', (h, e) => void vi.spyOn(h.outbox, 'enqueue').mockRejectedValueOnce(e)],
    ];

    it.each(failingWrites)(
      'a failing %s stores nothing and enqueues nothing; the retry with the same key is accepted',
      async (_write, failOnce) => {
        const h = createHarness();
        failOnce(h, new Error('connection reset'));
        await expect(h.submit()).rejects.toThrow('connection reset');
        expect(h.db.tables).toEqual(nothingStored);

        // Nothing was registered either, so the client's retry is a new, complete submission.
        const { documentId, replayed } = await h.submit();
        expect(replayed).toBe(false);
        expect(await h.eventTypes(documentId)).toEqual(['DocumentReceived']);
        expect(h.outboxMessages()).toHaveLength(1);
      },
    );
  });
});
