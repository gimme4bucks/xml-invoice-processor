import type {
  Blob,
  DocumentView,
  IdempotencyRecord,
  OutboxMessage,
  StoredEvent,
  Transaction,
} from '../../../application/ports';

export interface OutboxRow extends OutboxMessage {
  createdAt: Date;
  publishedAt?: Date;
  attempts: number;
  lastError?: string;
}

/** A blob with the sha256 of its bytes, taken when it was stored. */
export interface StoredBlob extends Blob {
  sha256: string;
}

interface Tables {
  events: StoredEvent[];
  views: Map<string, DocumentView>;
  blobs: Map<string, StoredBlob>;
  outbox: OutboxRow[];
  idempotency: IdempotencyRecord[];
}

const emptyTables = (): Tables => ({
  events: [],
  views: new Map(),
  blobs: new Map(),
  outbox: [],
  idempotency: [],
});

/**
 * Shared state behind all in-memory adapters (walking skeleton, unit tests). Transactions are
 * serialised and roll back to a snapshot on error, so the adapters honour the same atomicity
 * contract as the Postgres ones.
 */
export class InMemoryDatabase {
  tables: Tables = emptyTables();
  private tail: Promise<unknown> = Promise.resolve();

  transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const snapshot = structuredClone(this.tables);
      try {
        return await work({} as Transaction);
      } catch (error) {
        this.tables = snapshot;
        throw error;
      }
    };
    const result = this.tail.then(run, run);
    this.tail = result.catch(() => undefined);
    return result;
  }

  reset(): void {
    this.tables = emptyTables();
  }
}
