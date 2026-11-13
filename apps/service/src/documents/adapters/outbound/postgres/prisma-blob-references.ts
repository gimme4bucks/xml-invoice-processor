import { Injectable } from '@nestjs/common';
import type { Transaction } from '../../../application/ports';
import { type BlobReference, BlobReferences } from '../s3/blob-references';
import { guardUnavailable, PrismaService, prismaTx } from './prisma.service';

/**
 * The S3 BlobStore's references (ADR 0016): blobs rows without content, plus a transaction-level
 * advisory lock on each object's hash that keeps writers and the orphan collector apart. Writers
 * take it shared, so they never wait for each other; the collector only tries to take it
 * exclusively and skips the object when a writer holds it. Postgres releases the lock when the
 * transaction ends, and also when the process holding it dies.
 *
 * The lock key is `hashtextextended(sha256, 0)`, a bigint. A collision with another hash only
 * makes the collector skip an object until its next run. No other code uses advisory locks.
 */
@Injectable()
export class PrismaBlobReferences extends BlobReferences {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async holdForWrite(sha256: string, tx: Transaction): Promise<void> {
    await prismaTx(tx)
      .$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${sha256}, 0))`;
  }

  async record(reference: BlobReference, tx: Transaction): Promise<void> {
    const row = { contentType: reference.contentType, sha256: reference.sha256, content: null };
    await prismaTx(tx).blob.upsert({
      where: { key: reference.key },
      create: { key: reference.key, ...row },
      update: row,
    });
  }

  async find(key: string): Promise<BlobReference | undefined> {
    const row = await guardUnavailable(() =>
      this.prisma.blob.findUnique({
        where: { key },
        select: { key: true, contentType: true, sha256: true },
      }),
    );
    return row ?? undefined;
  }

  async removeIfUnreferenced(sha256: string, remove: () => Promise<void>): Promise<boolean> {
    return guardUnavailable(() =>
      this.prisma.$transaction(async (client) => {
        const [{ locked }] = await client.$queryRaw<[{ locked: boolean }]>`
          SELECT pg_try_advisory_xact_lock(hashtextextended(${sha256}, 0)) AS locked`;
        if (!locked) return false;
        const referenced = await client.blob.findFirst({
          where: { sha256 },
          select: { key: true },
        });
        if (referenced) return false;
        await remove();
        return true;
      }),
    );
  }
}
