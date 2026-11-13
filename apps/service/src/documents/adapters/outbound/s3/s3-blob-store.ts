import { Injectable } from '@nestjs/common';
import { type Blob, BlobStore, type Transaction } from '../../../application/ports';
import { BlobReferences } from './blob-references';
import { ObjectStore } from './object-store';

/** The BlobStore on S3: the bytes in the bucket, the reference in the database (ADR 0016). */
@Injectable()
export class S3BlobStore extends BlobStore {
  constructor(
    private readonly objects: ObjectStore,
    private readonly references: BlobReferences,
  ) {
    super();
  }

  async put(_blob: Blob, _tx: Transaction): Promise<void> {
    throw new Error('Not implemented');
  }

  async get(_key: string): Promise<Blob | undefined> {
    throw new Error('Not implemented');
  }
}
