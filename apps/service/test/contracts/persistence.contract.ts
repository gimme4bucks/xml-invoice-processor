import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DocumentEvent } from '../../src/documents/domain/document-events';
import {
  type BlobStore,
  ConcurrencyError,
  type DocumentView,
  type DocumentViews,
  type EventStore,
  IdempotencyRaceError,
  type IdempotencyRegistry,
  type Outbox,
  type OutboxMessage,
  type UnitOfWork,
} from '../../src/documents/application/ports';

/**
 * Behaviour every persistence adapter family must show. Runs against the in-memory adapters
 * (unit project) and against the Prisma/Postgres adapters (contract project, work package G03).
 * If both pass, swapping them is safe; that is what makes the walking skeleton trustworthy.
 */
export interface PersistenceHarness {
  uow: UnitOfWork;
  events: EventStore;
  views: DocumentViews;
  blobs: BlobStore;
  outbox: Outbox;
  idempotency: IdempotencyRegistry;
  /** Empties all tables (test databases only). */
  reset(): Promise<void>;
  close?(): Promise<void>;
}

const received = (documentId: string, organisationId = 'org-1'): DocumentEvent => ({
  type: 'DocumentReceived',
  documentId,
  organisationId,
  idempotencyKey: `key-${documentId}`,
  contentHash: `hash-${documentId}`,
  documentType: 'Invoice',
  direction: 'sales',
  receivedAt: '2026-11-12T10:00:00.000Z',
});
const started = (attempt = 1): DocumentEvent => ({
  type: 'ProcessingStarted',
  attempt,
  startedAt: '2026-11-12T10:00:01.000Z',
});
const metadata = { correlationId: 'corr-1', actor: 'contract-test' };

const view = (documentId: string, overrides: Partial<DocumentView> = {}): DocumentView => ({
  documentId,
  organisationId: 'org-1',
  documentType: 'Invoice',
  direction: 'sales',
  status: 'Received',
  attempts: 0,
  receivedAt: new Date('2026-11-12T10:00:00.000Z'),
  updatedAt: new Date('2026-11-12T10:00:00.000Z'),
  version: 1,
  ...overrides,
});

const message = (routingKey = 'process'): OutboxMessage => ({
  id: randomUUID(),
  routingKey,
  payload: { documentId: randomUUID(), attempt: 1 },
  headers: { 'x-correlation-id': 'corr-1' },
});

export function describePersistenceContract(
  name: string,
  createHarness: () => Promise<PersistenceHarness>,
): void {
  describe(`${name}: persistence port contract`, () => {
    let h: PersistenceHarness;

    beforeAll(async () => {
      h = await createHarness();
    });
    beforeEach(async () => {
      await h.reset();
    });
    afterAll(async () => {
      await h.close?.();
    });

    describe('EventStore', () => {
      it('appends a new stream at expected version 0 and loads it in version order', async () => {
        const id = randomUUID();
        const stored = await h.uow.run((tx) =>
          h.events.append(id, 0, [received(id), started()], metadata, tx),
        );
        expect(stored.map((e) => e.version)).toEqual([1, 2]);
        const loaded = await h.events.load(id);
        expect(loaded.map((e) => e.event.type)).toEqual(['DocumentReceived', 'ProcessingStarted']);
        expect(loaded[0]?.metadata).toMatchObject(metadata);
        expect(loaded[0]?.streamId).toBe(id);
      });

      it('returns an empty list for an unknown stream', async () => {
        expect(await h.events.load(randomUUID())).toEqual([]);
      });

      it('rejects an append at a stale expected version with ConcurrencyError', async () => {
        const id = randomUUID();
        await h.uow.run((tx) => h.events.append(id, 0, [received(id)], metadata, tx));
        await expect(
          h.uow.run((tx) => h.events.append(id, 0, [received(id)], metadata, tx)),
        ).rejects.toBeInstanceOf(ConcurrencyError);
        expect(await h.events.load(id)).toHaveLength(1);
      });

      it('lets exactly one of two concurrent appends at the same version win', async () => {
        const id = randomUUID();
        await h.uow.run((tx) => h.events.append(id, 0, [received(id)], metadata, tx));
        const results = await Promise.allSettled([
          h.uow.run((tx) => h.events.append(id, 1, [started(1)], metadata, tx)),
          h.uow.run((tx) => h.events.append(id, 1, [started(1)], metadata, tx)),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        const rejected = results.find((r) => r.status === 'rejected');
        expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(ConcurrencyError);
        expect(await h.events.load(id)).toHaveLength(2);
      });
    });

    describe('UnitOfWork', () => {
      it('commits every write of the unit together', async () => {
        const id = randomUUID();
        const outgoing = message();
        await h.uow.run(async (tx) => {
          await h.events.append(id, 0, [received(id)], metadata, tx);
          await h.views.upsert(view(id), tx);
          await h.blobs.put(
            { key: `k/${id}`, contentType: 'application/xml', content: Buffer.from('<a/>') },
            tx,
          );
          await h.outbox.enqueue([outgoing], tx);
        });
        expect(await h.events.load(id)).toHaveLength(1);
        expect(await h.views.get('org-1', id)).toBeDefined();
        expect(await h.blobs.get(`k/${id}`)).toBeDefined();
        const seen: string[] = [];
        await h.outbox.publishPending(10, async (m) => void seen.push(m.id));
        expect(seen).toContain(outgoing.id);
      });

      it('rolls back every write when the unit throws', async () => {
        const id = randomUUID();
        await expect(
          h.uow.run(async (tx) => {
            await h.events.append(id, 0, [received(id)], metadata, tx);
            await h.views.upsert(view(id), tx);
            await h.blobs.put(
              { key: `k/${id}`, contentType: 'application/xml', content: Buffer.from('<a/>') },
              tx,
            );
            await h.outbox.enqueue([message()], tx);
            await h.idempotency.register(
              { organisationId: 'org-1', idempotencyKey: 'k', contentHash: 'h', documentId: id },
              tx,
            );
            throw new Error('boom');
          }),
        ).rejects.toThrow('boom');
        expect(await h.events.load(id)).toEqual([]);
        expect(await h.views.get('org-1', id)).toBeUndefined();
        expect(await h.blobs.get(`k/${id}`)).toBeUndefined();
        const outcome = await h.outbox.publishPending(10, async () => undefined);
        expect(outcome.published).toBe(0);
        const again = await h.uow.run((tx) =>
          h.idempotency.register(
            { organisationId: 'org-1', idempotencyKey: 'k', contentHash: 'h', documentId: id },
            tx,
          ),
        );
        expect(again.outcome).toBe('registered');
      });
    });

    describe('DocumentViews', () => {
      it('upserts and reads a view, scoped by organisation', async () => {
        const id = randomUUID();
        await h.uow.run((tx) => h.views.upsert(view(id), tx));
        await h.uow.run((tx) =>
          h.views.upsert(
            view(id, {
              status: 'Failed',
              version: 3,
              attempts: 1,
              failure: { code: 'X', message: 'y' },
            }),
            tx,
          ),
        );
        expect(await h.views.get('org-1', id)).toMatchObject({
          status: 'Failed',
          version: 3,
          failure: { code: 'X', message: 'y' },
        });
        expect(await h.views.get('org-2', id)).toBeUndefined();
      });

      it('lists newest first with pagination and an optional status filter', async () => {
        const ids = [randomUUID(), randomUUID(), randomUUID()];
        await h.uow.run(async (tx) => {
          for (const [i, id] of ids.entries()) {
            await h.views.upsert(
              view(id, {
                receivedAt: new Date(Date.UTC(2026, 10, 12, 10, i)),
                status: i === 1 ? 'Completed' : 'Received',
              }),
              tx,
            );
          }
          await h.views.upsert(view(randomUUID(), { organisationId: 'org-2' }), tx);
        });
        const first = await h.views.list('org-1', { limit: 2 });
        expect(first.items.map((v) => v.documentId)).toEqual([ids[2], ids[1]]);
        expect(first.nextCursor).toBeDefined();
        const second = await h.views.list('org-1', { limit: 2, cursor: first.nextCursor });
        expect(second.items.map((v) => v.documentId)).toEqual([ids[0]]);
        expect(second.nextCursor).toBeUndefined();
        const completed = await h.views.list('org-1', { limit: 10, status: 'Completed' });
        expect(completed.items.map((v) => v.documentId)).toEqual([ids[1]]);
      });
    });

    describe('BlobStore', () => {
      it('round-trips bytes and returns undefined for a missing key', async () => {
        const content = Buffer.from('<Invoice>€ 100</Invoice>', 'utf8');
        await h.uow.run((tx) =>
          h.blobs.put({ key: 'x/original.xml', contentType: 'application/xml', content }, tx),
        );
        const blob = await h.blobs.get('x/original.xml');
        expect(blob?.contentType).toBe('application/xml');
        expect(Buffer.compare(blob!.content, content)).toBe(0);
        expect(await h.blobs.get('nope')).toBeUndefined();
      });
    });

    describe('Outbox', () => {
      it('hands pending messages oldest first and marks them published', async () => {
        const [a, b] = [message(), message()];
        await h.uow.run((tx) => h.outbox.enqueue([a], tx));
        await h.uow.run((tx) => h.outbox.enqueue([b], tx));
        const seen: OutboxMessage[] = [];
        expect(await h.outbox.publishPending(10, async (m) => void seen.push(m))).toEqual({
          published: 2,
          failed: 0,
        });
        expect(seen.map((m) => m.id)).toEqual([a.id, b.id]);
        expect(seen[0]).toEqual(a);
        expect(await h.outbox.publishPending(10, async () => undefined)).toEqual({
          published: 0,
          failed: 0,
        });
      });

      it('keeps a message pending when publish rejects and hands it out again later', async () => {
        const m = message();
        await h.uow.run((tx) => h.outbox.enqueue([m], tx));
        expect(
          await h.outbox.publishPending(10, async () => {
            throw new Error('broker down');
          }),
        ).toEqual({ published: 0, failed: 1 });
        const seen: string[] = [];
        expect(await h.outbox.publishPending(10, async (x) => void seen.push(x.id))).toEqual({
          published: 1,
          failed: 0,
        });
        expect(seen).toEqual([m.id]);
      });

      it('never hands the same message to two concurrent runs', async () => {
        const messages = Array.from({ length: 20 }, () => message());
        await h.uow.run((tx) => h.outbox.enqueue(messages, tx));
        const seen: string[] = [];
        const slowPublish = async (m: OutboxMessage) => {
          await new Promise((r) => setTimeout(r, 5));
          seen.push(m.id);
        };
        await Promise.all([
          h.outbox.publishPending(20, slowPublish),
          h.outbox.publishPending(20, slowPublish),
        ]);
        expect(seen.sort()).toEqual(messages.map((m) => m.id).sort());
      });
    });

    describe('IdempotencyRegistry', () => {
      const record = (
        overrides: Partial<{
          idempotencyKey: string;
          contentHash: string;
          organisationId: string;
        }> = {},
      ) => ({
        organisationId: 'org-1',
        idempotencyKey: 'key-1',
        contentHash: 'hash-1',
        documentId: randomUUID(),
        ...overrides,
      });
      const register = (r: ReturnType<typeof record>) =>
        h.uow.run((tx) => h.idempotency.register(r, tx));

      it('reports replayed, key-reused and duplicate-content against the first registration', async () => {
        const first = record();
        expect(await register(first)).toEqual({ outcome: 'registered' });
        expect(await register(record())).toEqual({
          outcome: 'replayed',
          documentId: first.documentId,
        });
        expect(await register(record({ contentHash: 'other' }))).toEqual({
          outcome: 'key-reused',
          documentId: first.documentId,
        });
        expect(await register(record({ idempotencyKey: 'key-2' }))).toEqual({
          outcome: 'duplicate-content',
          documentId: first.documentId,
        });
      });

      it('scopes keys and content per organisation', async () => {
        await register(record());
        expect(await register(record({ organisationId: 'org-2' }))).toEqual({
          outcome: 'registered',
        });
      });

      it('registers exactly once under concurrency (the loser may throw IdempotencyRaceError)', async () => {
        const results = await Promise.allSettled([register(record()), register(record())]);
        const outcomes = results.map((r) =>
          r.status === 'fulfilled'
            ? r.value.outcome
            : r.reason instanceof IdempotencyRaceError
              ? 'race'
              : 'error',
        );
        expect(outcomes.filter((o) => o === 'registered')).toHaveLength(1);
        expect(outcomes).not.toContain('error');
      });
    });
  });
}
