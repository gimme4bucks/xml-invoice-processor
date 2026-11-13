import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Blob, BlobStore, UnitOfWork } from '../../src/documents/application/ports';

/**
 * Behaviour every BlobStore adapter must show, whether the bytes live in Postgres or in an object
 * store (ADR 0016). Runs against the in-memory adapter (unit project) and against Postgres and
 * S3 (contract project).
 */
export interface BlobStoreHarness {
  uow: UnitOfWork;
  blobs: BlobStore;
  /** Replaces the stored bytes of `key` behind the adapter's back: bit rot, a bad copy or restore. */
  corrupt(key: string): Promise<void>;
  /** Empties the store (test stores only). */
  reset(): Promise<void>;
  close?(): Promise<void>;
}

const xml = (text: string): Blob => ({
  key: `documents/${randomUUID()}/original.xml`,
  contentType: 'application/xml',
  content: Buffer.from(text, 'utf8'),
});

export function describeBlobStoreContract(
  name: string,
  createHarness: () => Promise<BlobStoreHarness>,
): void {
  describe(`${name}: BlobStore contract`, () => {
    let h: BlobStoreHarness;
    const put = (blob: Blob) => h.uow.run((tx) => h.blobs.put(blob, tx));

    beforeAll(async () => {
      h = await createHarness();
    });
    beforeEach(async () => {
      await h.reset();
    });
    afterAll(async () => {
      await h.close?.();
    });

    it('round-trips the bytes and the content type', async () => {
      const blob = xml('<Invoice>€ 100</Invoice>');
      await put(blob);
      const stored = await h.blobs.get(blob.key);
      expect(stored?.key).toBe(blob.key);
      expect(stored?.contentType).toBe('application/xml');
      expect(Buffer.compare(stored!.content, blob.content)).toBe(0);
    });

    it('returns undefined for a key that was never stored', async () => {
      expect(await h.blobs.get(`documents/${randomUUID()}/original.xml`)).toBeUndefined();
    });

    it('returns undefined for a blob whose unit of work rolled back', async () => {
      const blob = xml('<Invoice>rolled back</Invoice>');
      await expect(
        h.uow.run(async (tx) => {
          await h.blobs.put(blob, tx);
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(await h.blobs.get(blob.key)).toBeUndefined();
    });

    it('takes the same content again, under the same key or another one, without harm', async () => {
      const blob = xml('<Invoice>twice</Invoice>');
      const sameBytes = { ...blob, key: `documents/${randomUUID()}/original.xml` };
      await put(blob);
      await put(blob);
      await put(sameBytes);
      for (const key of [blob.key, sameBytes.key]) {
        expect((await h.blobs.get(key))?.content.toString('utf8')).toBe('<Invoice>twice</Invoice>');
      }
    });

    it('refuses to return bytes that no longer match their sha256', async () => {
      const blob = xml('<Invoice>intact</Invoice>');
      await put(blob);
      await h.corrupt(blob.key);
      await expect(h.blobs.get(blob.key)).rejects.toThrow(/sha256/);
    });
  });
}
