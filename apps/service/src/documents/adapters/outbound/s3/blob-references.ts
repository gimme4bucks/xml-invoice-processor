import type { Transaction } from '../../../application/ports';

/** What the database keeps of a blob whose bytes are in the object store. */
export interface BlobReference {
  key: string;
  contentType: string;
  sha256: string;
}

/**
 * The database side of the S3 BlobStore (ADR 0016). A reference commits or rolls back with the
 * unit of work it was recorded in. A hold on a hash keeps the orphan collector away from an object
 * that a running transaction is about to reference. PrismaBlobReferences implements it with the
 * blobs table and Postgres advisory locks.
 */
export abstract class BlobReferences {
  /** Holds `sha256` against the collector until `tx` ends. Writers do not block each other. */
  abstract holdForWrite(sha256: string, tx: Transaction): Promise<void>;
  /** Points `key` at the object `sha256`, in `tx`. */
  abstract record(reference: BlobReference, tx: Transaction): Promise<void>;
  /** The committed reference of `key`, if any. */
  abstract find(key: string): Promise<BlobReference | undefined>;
  /**
   * Runs `remove` only when no committed reference points at `sha256` and no writer holds it, and
   * keeps new writers of `sha256` waiting until `remove` is done. Returns whether `remove` ran.
   */
  abstract removeIfUnreferenced(sha256: string, remove: () => Promise<void>): Promise<boolean>;
}
