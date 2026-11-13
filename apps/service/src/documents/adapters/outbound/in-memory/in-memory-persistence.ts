import { randomUUID } from 'node:crypto';
import type { DocumentEvent } from '../../../domain/document-events';
import type { DocumentStatus, DocumentType } from '../../../domain/value-objects';
import {
  type Blob,
  BlobStore,
  ConcurrencyError,
  type DocumentPage,
  type DocumentView,
  DocumentViews,
  type EventMetadata,
  EventStore,
  type IdempotencyOutcome,
  type IdempotencyRecord,
  IdempotencyRegistry,
  Outbox,
  type OutboxMessage,
  type StoredEvent,
  type StuckDocument,
  type Transaction,
  UnitOfWork,
} from '../../../application/ports';
import type { InMemoryDatabase } from './in-memory-database';

export class InMemoryUnitOfWork extends UnitOfWork {
  constructor(private readonly db: InMemoryDatabase) {
    super();
  }

  run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.db.transaction(work);
  }
}

export class InMemoryEventStore extends EventStore {
  constructor(private readonly db: InMemoryDatabase) {
    super();
  }

  async load(streamId: string): Promise<StoredEvent[]> {
    return structuredClone(this.db.tables.events.filter((e) => e.streamId === streamId));
  }

  async append(
    streamId: string,
    expectedVersion: number,
    events: readonly DocumentEvent[],
    metadata: EventMetadata,
    _tx: Transaction,
  ): Promise<StoredEvent[]> {
    const current = this.db.tables.events.filter((e) => e.streamId === streamId).length;
    if (current !== expectedVersion) throw new ConcurrencyError(streamId, expectedVersion);
    const stored = events.map((event, index) => ({
      eventId: randomUUID(),
      streamId,
      version: expectedVersion + index + 1,
      event: structuredClone(event),
      metadata: { ...metadata },
      occurredAt: new Date(),
    }));
    this.db.tables.events.push(...stored);
    return structuredClone(stored);
  }
}

export class InMemoryDocumentViews extends DocumentViews {
  constructor(private readonly db: InMemoryDatabase) {
    super();
  }

  async upsert(view: DocumentView, _tx: Transaction): Promise<void> {
    this.db.tables.views.set(view.documentId, structuredClone(view));
  }

  async get(organisationId: string, documentId: string): Promise<DocumentView | undefined> {
    const view = this.db.tables.views.get(documentId);
    return view?.organisationId === organisationId ? structuredClone(view) : undefined;
  }

  async list(
    organisationId: string,
    options: {
      limit: number;
      cursor?: string;
      status?: DocumentStatus;
      documentType?: DocumentType;
    },
  ): Promise<DocumentPage> {
    const all = [...this.db.tables.views.values()]
      .filter((v) => v.organisationId === organisationId)
      .filter((v) => !options.status || v.status === options.status)
      .filter((v) => !options.documentType || v.documentType === options.documentType)
      .sort(
        (a, b) =>
          b.receivedAt.getTime() - a.receivedAt.getTime() ||
          b.documentId.localeCompare(a.documentId),
      );
    const start = options.cursor ? Number(options.cursor) : 0;
    const items = all.slice(start, start + options.limit);
    const next = start + options.limit;
    return {
      items: structuredClone(items),
      ...(next < all.length ? { nextCursor: String(next) } : {}),
    };
  }

  async findStuck(options: { updatedBefore: Date; limit: number }): Promise<StuckDocument[]> {
    const pending = new Set(
      this.db.tables.outbox
        .filter((row) => !row.publishedAt)
        .map((row) => String(row.payload['documentId'])),
    );
    return [...this.db.tables.views.values()]
      .filter((v) => v.status === 'Received' || v.status === 'Processing')
      .filter((v) => v.updatedAt < options.updatedBefore && !pending.has(v.documentId))
      .sort(
        (a, b) =>
          a.updatedAt.getTime() - b.updatedAt.getTime() || a.documentId.localeCompare(b.documentId),
      )
      .slice(0, options.limit)
      .map(({ documentId, status, version, updatedAt }) => ({
        documentId,
        status,
        version,
        updatedAt: new Date(updatedAt),
      }));
  }
}

export class InMemoryBlobStore extends BlobStore {
  constructor(private readonly db: InMemoryDatabase) {
    super();
  }

  async put(blob: Blob, _tx: Transaction): Promise<void> {
    this.db.tables.blobs.set(blob.key, { ...blob, content: Buffer.from(blob.content) });
  }

  async get(key: string): Promise<Blob | undefined> {
    const blob = this.db.tables.blobs.get(key);
    // structuredClone (rollback snapshots) turns Buffers into Uint8Arrays; normalise back.
    return blob ? { ...blob, content: Buffer.from(blob.content) } : undefined;
  }
}

export class InMemoryOutbox extends Outbox {
  private readonly inFlight = new Set<string>();

  constructor(private readonly db: InMemoryDatabase) {
    super();
  }

  async enqueue(messages: readonly OutboxMessage[], _tx: Transaction): Promise<void> {
    const now = new Date();
    for (const message of messages) {
      this.db.tables.outbox.push({ ...structuredClone(message), createdAt: now, attempts: 0 });
    }
  }

  async publishPending(
    limit: number,
    publish: (message: OutboxMessage) => Promise<void>,
  ): Promise<{ published: number; failed: number }> {
    const batch = this.db.tables.outbox
      .filter((row) => !row.publishedAt && !this.inFlight.has(row.id))
      .slice(0, limit);
    batch.forEach((row) => this.inFlight.add(row.id));
    let published = 0;
    let failed = 0;
    try {
      for (const row of batch) {
        const { id, routingKey, payload, headers } = row;
        try {
          await publish({ id, routingKey, payload, headers });
          row.publishedAt = new Date();
          published++;
        } catch (error) {
          row.attempts++;
          row.lastError = error instanceof Error ? error.message : String(error);
          failed++;
        }
      }
    } finally {
      batch.forEach((row) => this.inFlight.delete(row.id));
    }
    return { published, failed };
  }
}

export class InMemoryIdempotencyRegistry extends IdempotencyRegistry {
  constructor(private readonly db: InMemoryDatabase) {
    super();
  }

  async register(record: IdempotencyRecord, _tx: Transaction): Promise<IdempotencyOutcome> {
    const sameOrg = this.db.tables.idempotency.filter(
      (r) => r.organisationId === record.organisationId,
    );
    const byKey = sameOrg.find((r) => r.idempotencyKey === record.idempotencyKey);
    if (byKey) {
      return byKey.contentHash === record.contentHash
        ? { outcome: 'replayed', documentId: byKey.documentId }
        : { outcome: 'key-reused', documentId: byKey.documentId };
    }
    const byHash = sameOrg.find((r) => r.contentHash === record.contentHash);
    if (byHash) return { outcome: 'duplicate-content', documentId: byHash.documentId };
    this.db.tables.idempotency.push({ ...record });
    return { outcome: 'registered' };
  }
}
