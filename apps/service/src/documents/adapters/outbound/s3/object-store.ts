/** An object in the bucket: its content address and when it was last written. */
export interface StoredObject {
  sha256: string;
  lastModified: Date;
}

/**
 * The bucket, addressed by content: an object's name is the sha256 of its bytes (ADR 0016).
 * S3ObjectStore talks to S3; the unit tests use a fake. An object store that cannot be reached or
 * does not answer in time is a PersistenceUnavailableError, like the database.
 */
export abstract class ObjectStore {
  /** Writes the bytes under their sha256. The same bytes again rewrite the same object: harmless. */
  abstract put(sha256: string, content: Buffer, contentType: string): Promise<void>;
  /** The bytes stored under `sha256`, or undefined when there is no such object. */
  abstract get(sha256: string): Promise<Buffer | undefined>;
  /** Every object in the bucket, in no particular order. */
  abstract list(): AsyncIterable<StoredObject>;
  /** Removes the object; removing one that is not there is not an error. */
  abstract delete(sha256: string): Promise<void>;
}
