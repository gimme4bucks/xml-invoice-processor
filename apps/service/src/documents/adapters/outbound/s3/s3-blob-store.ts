import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { type Blob, BlobStore, type Transaction } from '../../../application/ports';
import { BlobReferences } from './blob-references';
import { ObjectStore } from './object-store';

const sha256Of = (content: Buffer): string => createHash('sha256').update(content).digest('hex');

/**
 * The BlobStore on S3 (ADR 0016): the bytes in the bucket under their sha256, the reference in the
 * database. The bucket is outside the transaction, so the order is what keeps a document safe:
 *
 * 1. hold the hash against the orphan collector (until the unit of work ends);
 * 2. upload the object;
 * 3. record the reference in the caller's unit of work, which commits after this returns.
 *
 * A committed reference therefore always points at an uploaded object. When the unit of work
 * fails or the process dies before the commit, an unreferenced object stays behind, which
 * OrphanObjectCollector deletes later. The same bytes always get the same object, so a retry, a
 * redelivery or two organisations storing the same file are harmless.
 */
@Injectable()
export class S3BlobStore extends BlobStore {
  constructor(
    private readonly objects: ObjectStore,
    private readonly references: BlobReferences,
  ) {
    super();
  }

  async put(blob: Blob, tx: Transaction): Promise<void> {
    const sha256 = sha256Of(blob.content);
    await this.references.holdForWrite(sha256, tx);
    await this.objects.put(sha256, blob.content, blob.contentType);
    await this.references.record({ key: blob.key, contentType: blob.contentType, sha256 }, tx);
  }

  /** Never hands out bytes that are not the ones referenced; a lost object is an error. */
  async get(key: string): Promise<Blob | undefined> {
    const reference = await this.references.find(key);
    if (!reference) return undefined;
    const content = await this.objects.get(reference.sha256);
    if (!content) throw new Error(`The object of blob ${key} is missing from the bucket`);
    if (sha256Of(content) !== reference.sha256) {
      throw new Error(`Blob ${key} does not match its sha256`);
    }
    return { key, contentType: reference.contentType, content };
  }
}
