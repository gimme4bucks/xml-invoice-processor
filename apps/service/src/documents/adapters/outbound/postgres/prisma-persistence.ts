import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { DocumentEvent, FailureReason } from '../../../domain/document-events';
import type { DocumentStatus, DocumentType, InvoiceDirection } from '../../../domain/value-objects';
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
  IdempotencyRaceError,
  type IdempotencyRecord,
  IdempotencyRegistry,
  Outbox,
  type OutboxMessage,
  type StoredEvent,
  type StuckDocument,
  type Transaction,
  UnitOfWork,
} from '../../../application/ports';
import { type DocumentView as DocumentViewRow, Prisma } from '../../../../generated/prisma/client';
import {
  asTransaction,
  guardUnavailable,
  isUniqueViolation,
  PrismaService,
  prismaTx,
  toJson,
} from './prisma.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Upper bound for one relay transaction: it holds the row lock while the broker confirms, so it
 * must outlast the publisher's own confirm timeout (5 s, ADR 0006). Anything slower is a bug.
 */
const RELAY_TRANSACTION_TIMEOUT_MS = 15_000;

/**
 * One interactive transaction; its client is the Transaction every adapter writes with. Writes
 * only happen inside `run`, so its guard covers them; reads outside a transaction guard themselves.
 * The relay's transactions (PrismaOutbox) are not guarded: nobody waits for them, and the relay
 * loop logs a failure and tries again.
 */
@Injectable()
export class PrismaUnitOfWork extends UnitOfWork {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    return guardUnavailable(() =>
      this.prisma.$transaction((client) => work(asTransaction(client))),
    );
  }
}

@Injectable()
export class PrismaEventStore extends EventStore {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async load(streamId: string): Promise<StoredEvent[]> {
    const rows = await guardUnavailable(() =>
      this.prisma.event.findMany({ where: { streamId }, orderBy: { version: 'asc' } }),
    );
    return rows.map((row) => ({
      eventId: row.eventId,
      streamId: row.streamId,
      version: row.version,
      event: { type: row.type, ...(row.data as Prisma.JsonObject) } as unknown as DocumentEvent,
      metadata: row.metadata as unknown as EventMetadata,
      occurredAt: row.occurredAt,
    }));
  }

  /**
   * The version check catches a writer that committed before us; the unique (stream_id, version)
   * index catches one that commits while we are still running. Both are a ConcurrencyError.
   */
  async append(
    streamId: string,
    expectedVersion: number,
    events: readonly DocumentEvent[],
    metadata: EventMetadata,
    tx: Transaction,
  ): Promise<StoredEvent[]> {
    const client = prismaTx(tx);
    const last = await client.event.findFirst({
      where: { streamId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    if ((last?.version ?? 0) !== expectedVersion) {
      throw new ConcurrencyError(streamId, expectedVersion);
    }
    const occurredAt = new Date();
    const stored: StoredEvent[] = events.map((event, index) => ({
      eventId: randomUUID(),
      streamId,
      version: expectedVersion + index + 1,
      event: structuredClone(event),
      metadata: { ...metadata },
      occurredAt,
    }));
    try {
      await client.event.createMany({
        data: stored.map(({ eventId, version, event: { type, ...data } }) => ({
          eventId,
          streamId,
          version,
          type,
          data: toJson(data),
          metadata: toJson(metadata),
          occurredAt,
        })),
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConcurrencyError(streamId, expectedVersion);
      throw error;
    }
    return stored;
  }
}

@Injectable()
export class PrismaDocumentViews extends DocumentViews {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async upsert(view: DocumentView, tx: Transaction): Promise<void> {
    const row = {
      organisationId: view.organisationId,
      documentType: view.documentType,
      direction: view.direction,
      status: view.status,
      attempts: view.attempts,
      failure: view.failure ? toJson(view.failure) : Prisma.DbNull,
      receivedAt: view.receivedAt,
      updatedAt: view.updatedAt,
      completedAt: view.completedAt ?? null,
      version: view.version,
    };
    await prismaTx(tx).documentView.upsert({
      where: { documentId: view.documentId },
      create: { documentId: view.documentId, ...row },
      update: row,
    });
  }

  async get(organisationId: string, documentId: string): Promise<DocumentView | undefined> {
    // A malformed id (it comes from the URL) cannot exist; Postgres would reject it as a uuid.
    if (!UUID.test(documentId)) return undefined;
    const row = await guardUnavailable(() =>
      this.prisma.documentView.findFirst({ where: { documentId, organisationId } }),
    );
    return row ? toView(row) : undefined;
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
    return this.page({ ...options, organisationId });
  }

  async listAcrossOrganisations(options: {
    limit: number;
    cursor?: string;
    organisationId?: string;
    status?: DocumentStatus;
    documentType?: DocumentType;
  }): Promise<DocumentPage> {
    return this.page(options);
  }

  /** Keyset pagination on (received_at DESC, document_id DESC): stable while new rows arrive. */
  private async page(options: {
    limit: number;
    cursor?: string;
    organisationId?: string;
    status?: DocumentStatus;
    documentType?: DocumentType;
  }): Promise<DocumentPage> {
    const after = options.cursor ? decodeCursor(options.cursor) : undefined;
    const rows = await guardUnavailable(() =>
      this.prisma.documentView.findMany({
        where: {
          ...(options.organisationId ? { organisationId: options.organisationId } : {}),
          ...(options.status ? { status: options.status } : {}),
          ...(options.documentType ? { documentType: options.documentType } : {}),
          ...(after
            ? {
                OR: [
                  { receivedAt: { lt: after.receivedAt } },
                  { receivedAt: after.receivedAt, documentId: { lt: after.documentId } },
                ],
              }
            : {}),
        },
        orderBy: [{ receivedAt: 'desc' }, { documentId: 'desc' }],
        take: options.limit + 1,
      }),
    );
    const items = rows.slice(0, options.limit).map(toView);
    const last = items.at(-1);
    return {
      items,
      ...(rows.length > options.limit && last ? { nextCursor: encodeCursor(last) } : {}),
    };
  }

  /**
   * Uses document_views_status_updated_idx; the NOT EXISTS only looks at pending outbox rows
   * (outbox_pending_idx), of which there are few unless the broker is down.
   */
  async findStuck(options: { updatedBefore: Date; limit: number }): Promise<StuckDocument[]> {
    const rows = await guardUnavailable(
      () => this.prisma.$queryRaw<
        Array<{ document_id: string; status: string; version: number; updated_at: Date }>
      >`
        SELECT v.document_id, v.status, v.version, v.updated_at
        FROM document_views v
        WHERE v.status IN ('Received', 'Processing')
          AND v.updated_at < ${options.updatedBefore}
          AND NOT EXISTS (
            SELECT 1 FROM outbox o
            WHERE o.published_at IS NULL AND o.payload->>'documentId' = v.document_id::text)
        ORDER BY v.updated_at, v.document_id
        LIMIT ${options.limit}`,
    );
    return rows.map((row) => ({
      documentId: row.document_id,
      status: row.status as DocumentStatus,
      version: row.version,
      updatedAt: row.updated_at,
    }));
  }
}

function toView(row: DocumentViewRow): DocumentView {
  return {
    documentId: row.documentId,
    organisationId: row.organisationId,
    documentType: row.documentType as DocumentType,
    direction: row.direction as InvoiceDirection,
    status: row.status as DocumentStatus,
    attempts: row.attempts,
    ...(row.failure ? { failure: row.failure as unknown as FailureReason } : {}),
    receivedAt: row.receivedAt,
    updatedAt: row.updatedAt,
    ...(row.completedAt ? { completedAt: row.completedAt } : {}),
    version: row.version,
  };
}

/** The cursor is opaque to clients: base64url of the last row's sort key. */
function encodeCursor(view: DocumentView): string {
  return Buffer.from(JSON.stringify([view.receivedAt.toISOString(), view.documentId])).toString(
    'base64url',
  );
}

function decodeCursor(cursor: string): { receivedAt: Date; documentId: string } {
  try {
    const [receivedAt, documentId] = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as unknown[];
    const date = new Date(receivedAt as string);
    if (typeof documentId === 'string' && UUID.test(documentId) && !Number.isNaN(date.getTime())) {
      return { receivedAt: date, documentId };
    }
  } catch {
    // Fall through: not ours.
  }
  throw new Error('Invalid pagination cursor');
}

@Injectable()
export class PrismaBlobStore extends BlobStore {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async put(blob: Blob, tx: Transaction): Promise<void> {
    const row = {
      contentType: blob.contentType,
      // Prisma's Bytes input wants a Uint8Array over a plain ArrayBuffer; a Buffer may share a pool.
      content: new Uint8Array(blob.content),
      sha256: createHash('sha256').update(blob.content).digest('hex'),
    };
    await prismaTx(tx).blob.upsert({
      where: { key: blob.key },
      create: { key: blob.key, ...row },
      update: row,
    });
  }

  /** Never hands out bytes that changed since they were stored (ADR 0016). */
  async get(key: string): Promise<Blob | undefined> {
    const row = await guardUnavailable(() => this.prisma.blob.findUnique({ where: { key } }));
    if (!row) return undefined;
    if (row.content === null) {
      throw new Error(`Blob ${key} is in the object store: reading it needs BLOB_STORE=s3`);
    }
    const content = Buffer.from(row.content);
    if (createHash('sha256').update(content).digest('hex') !== row.sha256) {
      throw new Error(`Blob ${key} does not match its sha256`);
    }
    return { key: row.key, contentType: row.contentType, content };
  }
}

interface PendingOutboxRow {
  id: string;
  routing_key: string;
  payload: Record<string, unknown>;
  headers: Record<string, string>;
}

@Injectable()
export class PrismaOutbox extends Outbox {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async enqueue(messages: readonly OutboxMessage[], tx: Transaction): Promise<void> {
    if (messages.length === 0) return;
    await prismaTx(tx).outboxMessage.createMany({
      data: messages.map((m) => ({
        id: m.id,
        routingKey: m.routingKey,
        payload: toJson(m.payload),
        headers: toJson(m.headers),
      })),
    });
  }

  /**
   * One short transaction per message: claim the oldest unlocked pending row with
   * FOR UPDATE SKIP LOCKED, publish it while holding the lock, then record the outcome. A
   * concurrent relay skips the locked row, so a message is never handed out twice at once.
   * A failed message is not retried within the same run, so it cannot block the ones behind it.
   */
  async publishPending(
    limit: number,
    publish: (message: OutboxMessage) => Promise<void>,
  ): Promise<{ published: number; failed: number }> {
    const attempted: string[] = [];
    let published = 0;
    let failed = 0;
    while (attempted.length < limit) {
      const outcome = await this.prisma.$transaction(
        async (client) => {
          const [row] = await client.$queryRaw<PendingOutboxRow[]>`
            SELECT id, routing_key, payload, headers
            FROM outbox
            WHERE published_at IS NULL AND NOT (id = ANY(${attempted}::uuid[]))
            ORDER BY created_at, id
            LIMIT 1
            FOR UPDATE SKIP LOCKED`;
          if (!row) return 'empty';
          attempted.push(row.id);
          try {
            await publish({
              id: row.id,
              routingKey: row.routing_key,
              payload: row.payload,
              headers: row.headers,
            });
          } catch (error) {
            await client.outboxMessage.update({
              where: { id: row.id },
              data: {
                attempts: { increment: 1 },
                lastError: error instanceof Error ? error.message : String(error),
              },
            });
            return 'failed';
          }
          await client.outboxMessage.update({
            where: { id: row.id },
            data: { publishedAt: new Date() },
          });
          return 'published';
        },
        { timeout: RELAY_TRANSACTION_TIMEOUT_MS },
      );
      if (outcome === 'empty') break;
      if (outcome === 'published') published++;
      else failed++;
    }
    return { published, failed };
  }
}

@Injectable()
export class PrismaIdempotencyRegistry extends IdempotencyRegistry {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  /**
   * Select, then insert. Two concurrent requests can both miss in the select; the unique
   * indexes on (organisation, key) and (organisation, content hash) let only one insert win.
   */
  async register(record: IdempotencyRecord, tx: Transaction): Promise<IdempotencyOutcome> {
    const client = prismaTx(tx);
    const matches = await client.idempotencyRecord.findMany({
      where: {
        organisationId: record.organisationId,
        OR: [{ idempotencyKey: record.idempotencyKey }, { contentHash: record.contentHash }],
      },
    });
    const byKey = matches.find((r) => r.idempotencyKey === record.idempotencyKey);
    if (byKey) {
      return byKey.contentHash === record.contentHash
        ? { outcome: 'replayed', documentId: byKey.documentId }
        : { outcome: 'key-reused', documentId: byKey.documentId };
    }
    const byHash = matches.find((r) => r.contentHash === record.contentHash);
    if (byHash) return { outcome: 'duplicate-content', documentId: byHash.documentId };
    try {
      await client.idempotencyRecord.create({
        data: {
          organisationId: record.organisationId,
          idempotencyKey: record.idempotencyKey,
          contentHash: record.contentHash,
          documentId: record.documentId,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new IdempotencyRaceError();
      throw error;
    }
    return { outcome: 'registered' };
  }
}
