import type { DocumentEvent, FailureReason } from '../../domain/document-events';
import type { DocumentStatus, DocumentType, InvoiceDirection } from '../../domain/value-objects';

// Ports are abstract classes so they double as NestJS injection tokens without importing
// NestJS here. Every write takes the Transaction of the surrounding unit of work.

/** Opaque handle of a running transaction; each adapter family knows its real shape. */
export interface Transaction {
  readonly __transaction: unique symbol;
}

/** Runs work atomically: everything written with the given transaction commits or nothing does. */
export abstract class UnitOfWork {
  abstract run<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
}

export interface EventMetadata {
  correlationId: string;
  causationId?: string;
  /** Who caused the event, e.g. the OAuth client id. Audit trail. */
  actor?: string;
}

export interface StoredEvent {
  eventId: string;
  streamId: string;
  /** 1-based position within the stream. */
  version: number;
  event: DocumentEvent;
  metadata: EventMetadata;
  occurredAt: Date;
}

/** Thrown when the stream's version is not the expected one (concurrent writer). */
export class ConcurrencyError extends Error {
  constructor(streamId: string, expectedVersion: number) {
    super(`Stream ${streamId} is not at version ${expectedVersion}`);
    this.name = 'ConcurrencyError';
  }
}

/**
 * Transient: the database could not be reached or did not answer in time. Usually nothing was
 * committed, but after a timeout the outcome is unknown (the call may still commit). The API
 * answers 503 and the client retries with the same Idempotency-Key; the worker requeues the
 * message. Both paths are idempotent, so either outcome is safe.
 */
export class PersistenceUnavailableError extends Error {
  constructor(reason: string) {
    super(`Persistence unavailable: ${reason}`);
    this.name = 'PersistenceUnavailableError';
  }
}

export abstract class EventStore {
  /** All events of the stream in version order; empty when the stream does not exist. */
  abstract load(streamId: string): Promise<StoredEvent[]>;

  /**
   * Appends events after `expectedVersion` (0 for a new stream). Throws ConcurrencyError when
   * another writer got there first. Events are immutable once appended.
   */
  abstract append(
    streamId: string,
    expectedVersion: number,
    events: readonly DocumentEvent[],
    metadata: EventMetadata,
    tx: Transaction,
  ): Promise<StoredEvent[]>;
}

/** Read model row, projected in the same transaction as the events it reflects. */
export interface DocumentView {
  documentId: string;
  organisationId: string;
  documentType: DocumentType;
  direction: InvoiceDirection;
  status: DocumentStatus;
  attempts: number;
  failure?: FailureReason;
  receivedAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  /** Stream version the view reflects. */
  version: number;
}

export interface DocumentPage {
  items: DocumentView[];
  /** Opaque cursor for the next page; absent on the last page. */
  nextCursor?: string;
}

/** A document the sweeper may send to the worker again (ADR 0014). */
export interface StuckDocument {
  documentId: string;
  status: DocumentStatus;
  /** Stream version of the read model row: the expected version of the requeue. */
  version: number;
  updatedAt: Date;
}

export abstract class DocumentViews {
  abstract upsert(view: DocumentView, tx: Transaction): Promise<void>;
  /** Scoped by organisation: another organisation's document is simply not found. */
  abstract get(organisationId: string, documentId: string): Promise<DocumentView | undefined>;
  /** Newest first; `status` and `documentType` narrow the list when given. */
  abstract list(
    organisationId: string,
    options: {
      limit: number;
      cursor?: string;
      status?: DocumentStatus;
      documentType?: DocumentType;
    },
  ): Promise<DocumentPage>;
  /**
   * **Support only (ADR 0017), across all organisations.** Like `list`, newest first, but not
   * scoped to the caller's organisation: `organisationId` is an optional filter here. Never call
   * it for an organisation's own request; that is what `list` is for.
   */
  abstract listAcrossOrganisations(options: {
    limit: number;
    cursor?: string;
    organisationId?: string;
    status?: DocumentStatus;
    documentType?: DocumentType;
  }): Promise<DocumentPage>;
  /**
   * For the sweeper, across all organisations: documents that are not final, whose read model
   * has not changed since before `updatedBefore`, and that have no unpublished outbox message
   * (one waiting for the relay is not stuck). Least recently changed first.
   */
  abstract findStuck(options: { updatedBefore: Date; limit: number }): Promise<StuckDocument[]>;
}

export interface Blob {
  key: string;
  contentType: string;
  content: Buffer;
}

export abstract class BlobStore {
  abstract put(blob: Blob, tx: Transaction): Promise<void>;
  abstract get(key: string): Promise<Blob | undefined>;
}

export interface OutboxMessage {
  /** Also used as the AMQP messageId, so duplicates can be recognised downstream. */
  id: string;
  routingKey: string;
  payload: Record<string, unknown>;
  headers: Record<string, string>;
}

export abstract class Outbox {
  abstract enqueue(messages: readonly OutboxMessage[], tx: Transaction): Promise<void>;

  /**
   * Hands up to `limit` unpublished messages, oldest first, to `publish` and marks each one
   * published only after `publish` resolved. A message whose publish rejects stays pending
   * (attempts and last error are recorded). Safe to run concurrently: a message is handed to
   * at most one caller at a time.
   */
  abstract publishPending(
    limit: number,
    publish: (message: OutboxMessage) => Promise<void>,
  ): Promise<{ published: number; failed: number }>;
}

export interface IdempotencyRecord {
  organisationId: string;
  idempotencyKey: string;
  contentHash: string;
  documentId: string;
}

export type IdempotencyOutcome =
  | { outcome: 'registered' }
  /** Same key and same content: a retry of a request we already accepted. */
  | { outcome: 'replayed'; documentId: string }
  /** Same key, different content: client error (409). */
  | { outcome: 'key-reused'; documentId: string }
  /** Different key, byte-identical content from the same organisation (409). */
  | { outcome: 'duplicate-content'; documentId: string };

/** Thrown when a concurrent request registered the same key or content first; retry the command. */
export class IdempotencyRaceError extends Error {
  constructor() {
    super('A concurrent request registered the same idempotency key or content');
    this.name = 'IdempotencyRaceError';
  }
}

export abstract class IdempotencyRegistry {
  /** Registers the record, or reports which earlier document it collides with. */
  abstract register(record: IdempotencyRecord, tx: Transaction): Promise<IdempotencyOutcome>;
}
