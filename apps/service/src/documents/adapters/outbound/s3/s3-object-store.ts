import { ObjectStore, type StoredObject } from './object-store';
import type { S3Config } from './s3-config';

/** The bucket on S3 or a local S3-compatible server. */
export class S3ObjectStore extends ObjectStore {
  constructor(private readonly config: S3Config) {
    super();
  }

  async put(_sha256: string, _content: Buffer, _contentType: string): Promise<void> {
    throw new Error('Not implemented');
  }

  async get(_sha256: string): Promise<Buffer | undefined> {
    throw new Error('Not implemented');
  }

  // eslint-disable-next-line require-yield
  async *list(): AsyncIterable<StoredObject> {
    throw new Error('Not implemented');
  }

  async delete(_sha256: string): Promise<void> {
    throw new Error('Not implemented');
  }
}
