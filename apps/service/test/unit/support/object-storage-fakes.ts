import { type Transaction, UnitOfWork } from '../../../src/documents/application/ports';
import {
  type BlobReference,
  BlobReferences,
} from '../../../src/documents/adapters/outbound/s3/blob-references';
import {
  ObjectStore,
  type StoredObject,
} from '../../../src/documents/adapters/outbound/s3/object-store';

/** A bucket in memory. `now` stamps each write, so object ages are explicit in a test. */
export class FakeObjectStore extends ObjectStore {
  readonly objects = new Map<string, { content: Buffer; lastModified: Date }>();
  now = new Date('2026-11-13T10:00:00.000Z');

  async put(sha256: string, content: Buffer, _contentType: string): Promise<void> {
    this.objects.set(sha256, { content: Buffer.from(content), lastModified: this.now });
  }

  async get(sha256: string): Promise<Buffer | undefined> {
    const object = this.objects.get(sha256);
    return object ? Buffer.from(object.content) : undefined;
  }

  async *list(): AsyncIterable<StoredObject> {
    for (const [sha256, { lastModified }] of [...this.objects]) yield { sha256, lastModified };
  }

  async delete(sha256: string): Promise<void> {
    this.objects.delete(sha256);
  }
}

interface FakeTx {
  references: BlobReference[];
  holds: string[];
}

/**
 * The database behind the S3 BlobStore, in memory: a unit of work commits its references only
 * when its work succeeds, and its holds last until it ends. `crash()` is the process dying: every
 * open unit of work is gone without a commit, and the database releases its holds.
 */
export class FakeReferenceDatabase {
  readonly committed = new Map<string, BlobReference>();
  private readonly open = new Set<FakeTx>();

  readonly uow: UnitOfWork = new (class extends UnitOfWork {
    constructor(private readonly db: FakeReferenceDatabase) {
      super();
    }

    async run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
      const tx: FakeTx = { references: [], holds: [] };
      this.db.open.add(tx);
      try {
        const result = await work(tx as unknown as Transaction);
        if (this.db.open.has(tx)) {
          for (const reference of tx.references) this.db.committed.set(reference.key, reference);
        }
        return result;
      } finally {
        this.db.open.delete(tx);
      }
    }
  })(this);

  readonly references: BlobReferences = new (class extends BlobReferences {
    constructor(private readonly db: FakeReferenceDatabase) {
      super();
    }

    async holdForWrite(sha256: string, tx: Transaction): Promise<void> {
      (tx as unknown as FakeTx).holds.push(sha256);
    }

    async record(reference: BlobReference, tx: Transaction): Promise<void> {
      (tx as unknown as FakeTx).references.push({ ...reference });
    }

    async find(key: string): Promise<BlobReference | undefined> {
      const reference = this.db.committed.get(key);
      return reference ? { ...reference } : undefined;
    }

    async removeIfUnreferenced(sha256: string, remove: () => Promise<void>): Promise<boolean> {
      const held = [...this.db.open].some((tx) => tx.holds.includes(sha256));
      const referenced = [...this.db.committed.values()].some((r) => r.sha256 === sha256);
      if (held || referenced) return false;
      await remove();
      return true;
    }
  })(this);

  crash(): void {
    this.open.clear();
  }

  reset(): void {
    this.committed.clear();
    this.open.clear();
  }
}
