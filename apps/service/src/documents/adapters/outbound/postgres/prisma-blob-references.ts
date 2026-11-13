import { Injectable } from '@nestjs/common';
import type { Transaction } from '../../../application/ports';
import { type BlobReference, BlobReferences } from '../s3/blob-references';
import { PrismaService } from './prisma.service';

/** The S3 BlobStore's references in the blobs table, guarded by advisory locks (ADR 0016). */
@Injectable()
export class PrismaBlobReferences extends BlobReferences {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async holdForWrite(_sha256: string, _tx: Transaction): Promise<void> {
    throw new Error('Not implemented');
  }

  async record(_reference: BlobReference, _tx: Transaction): Promise<void> {
    throw new Error('Not implemented');
  }

  async find(_key: string): Promise<BlobReference | undefined> {
    throw new Error('Not implemented');
  }

  async removeIfUnreferenced(_sha256: string, _remove: () => Promise<void>): Promise<boolean> {
    throw new Error('Not implemented');
  }
}
