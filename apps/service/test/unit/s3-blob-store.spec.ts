import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OrphanObjectCollector } from '../../src/documents/adapters/outbound/s3/orphan-objects';
import { S3BlobStore } from '../../src/documents/adapters/outbound/s3/s3-blob-store';
import { type Blob, PersistenceUnavailableError } from '../../src/documents/application/ports';
import { describeBlobStoreContract } from '../contracts/blob-store.contract';
import { FakeObjectStore, FakeReferenceDatabase } from './support/object-storage-fakes';

const sha256 = (content: Buffer) => createHash('sha256').update(content).digest('hex');

const blob = (text: string, key = 'documents/doc-1/original.xml'): Blob => ({
  key,
  contentType: 'application/xml',
  content: Buffer.from(text, 'utf8'),
});

/** A promise and the function that resolves it, to hold a unit of work open at a known point. */
function gate(): { opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

describeBlobStoreContract('s3 (fake bucket and references)', async () => {
  const objects = new FakeObjectStore();
  const db = new FakeReferenceDatabase();
  return {
    uow: db.uow,
    blobs: new S3BlobStore(objects, db.references),
    corrupt: async (key) => {
      const reference = db.committed.get(key);
      if (!reference) throw new Error(`No blob ${key} to corrupt`);
      await objects.put(reference.sha256, Buffer.from('<Invoice>tampered</Invoice>'), 'x');
    },
    reset: async () => {
      objects.objects.clear();
      db.reset();
    },
  };
});

describe('S3BlobStore: object first, then the reference', () => {
  let objects: FakeObjectStore;
  let db: FakeReferenceDatabase;
  let blobs: S3BlobStore;
  let collector: OrphanObjectCollector;
  /** Collects every object written before now + 1 h: in these tests, all of them. */
  const collectAll = () => collector.collect(new Date(objects.now.getTime() + 3_600_000));

  beforeEach(() => {
    objects = new FakeObjectStore();
    db = new FakeReferenceDatabase();
    blobs = new S3BlobStore(objects, db.references);
    collector = new OrphanObjectCollector(objects, db.references);
  });

  it('uploads the object under the sha256 of its bytes before the reference commits', async () => {
    const original = blob('<Invoice>1</Invoice>');
    await db.uow.run(async (tx) => {
      await blobs.put(original, tx);
      // Inside the unit of work: the object is in the bucket, the reference not yet committed.
      expect(await objects.get(sha256(original.content))).toEqual(original.content);
      expect(await blobs.get(original.key)).toBeUndefined();
    });
    expect(db.committed.get(original.key)).toEqual({
      key: original.key,
      contentType: 'application/xml',
      sha256: sha256(original.content),
    });
  });

  it('records nothing when the upload fails, and the caller gets the error', async () => {
    vi.spyOn(objects, 'put').mockRejectedValueOnce(new PersistenceUnavailableError('ECONNREFUSED'));
    const record = vi.spyOn(db.references, 'record');
    const original = blob('<Invoice>2</Invoice>');
    await expect(db.uow.run((tx) => blobs.put(original, tx))).rejects.toBeInstanceOf(
      PersistenceUnavailableError,
    );
    expect(record).not.toHaveBeenCalled();
    expect(objects.objects.size).toBe(0);
    expect(await blobs.get(original.key)).toBeUndefined();
  });

  it('leaves no reference when the transaction fails after the upload; the collector removes the object', async () => {
    const original = blob('<Invoice>3</Invoice>');
    await expect(
      db.uow.run(async (tx) => {
        await blobs.put(original, tx);
        throw new Error('the outbox insert failed'); // a later write of the same unit of work
      }),
    ).rejects.toThrow('the outbox insert failed');
    expect(await blobs.get(original.key)).toBeUndefined();
    expect(objects.objects.has(sha256(original.content))).toBe(true); // an orphan, for now

    expect(await collectAll()).toEqual({ examined: 1, removed: 1 });
    expect(objects.objects.size).toBe(0);
  });

  it('leaves no reference when the upload landed but its answer was lost (timeout)', async () => {
    const upload = objects.put.bind(objects);
    vi.spyOn(objects, 'put').mockImplementationOnce(async (...args) => {
      await upload(...args);
      throw new PersistenceUnavailableError('TimeoutError');
    });
    const original = blob('<Invoice>4</Invoice>');
    await expect(db.uow.run((tx) => blobs.put(original, tx))).rejects.toBeInstanceOf(
      PersistenceUnavailableError,
    );
    expect(await blobs.get(original.key)).toBeUndefined();
    expect(await collectAll()).toEqual({ examined: 1, removed: 1 });
  });

  it('leaves no reference when the process dies between the upload and the commit; the collector removes the object', async () => {
    const original = blob('<Invoice>5</Invoice>');
    const uploaded = gate();
    void db.uow.run(async (tx) => {
      await blobs.put(original, tx);
      uploaded.open();
      await new Promise(() => undefined); // the process dies here: this unit never commits
    });
    await uploaded.opened;
    db.crash();

    expect(await blobs.get(original.key)).toBeUndefined();
    expect(await collectAll()).toEqual({ examined: 1, removed: 1 });
    expect(objects.objects.size).toBe(0);
  });

  it('a retry after a failed unit of work stores the same object again and references it', async () => {
    const original = blob('<Invoice>6</Invoice>');
    await expect(
      db.uow.run(async (tx) => {
        await blobs.put(original, tx);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await db.uow.run((tx) => blobs.put(original, tx));
    expect((await blobs.get(original.key))?.content).toEqual(original.content);
    expect(await collectAll()).toEqual({ examined: 1, removed: 0 });
  });

  it('reports a referenced object that is gone from the bucket as an error, not as missing', async () => {
    const original = blob('<Invoice>7</Invoice>');
    await db.uow.run((tx) => blobs.put(original, tx));
    objects.objects.clear();
    await expect(blobs.get(original.key)).rejects.toThrow(/missing from the bucket/);
  });
});

describe('OrphanObjectCollector', () => {
  let objects: FakeObjectStore;
  let db: FakeReferenceDatabase;
  let blobs: S3BlobStore;
  let collector: OrphanObjectCollector;

  beforeEach(() => {
    objects = new FakeObjectStore();
    db = new FakeReferenceDatabase();
    blobs = new S3BlobStore(objects, db.references);
    collector = new OrphanObjectCollector(objects, db.references);
  });

  const orphan = async (text: string, writtenAt: string) => {
    objects.now = new Date(writtenAt);
    await db.uow
      .run(async (tx) => {
        await blobs.put(blob(text, `documents/${text}/original.xml`), tx);
        throw new Error('rolled back');
      })
      .catch(() => undefined);
    return sha256(Buffer.from(text));
  };

  it('removes unreferenced objects written before the cutoff, and keeps referenced and recent ones', async () => {
    const old = await orphan('old', '2026-11-13T08:00:00.000Z');
    const recent = await orphan('recent', '2026-11-13T09:30:00.000Z');
    objects.now = new Date('2026-11-13T08:00:00.000Z');
    const kept = blob('<Invoice>kept</Invoice>', 'documents/kept/original.xml');
    await db.uow.run((tx) => blobs.put(kept, tx));
    // Another key with the same bytes: one object, two references.
    await db.uow.run((tx) => blobs.put({ ...kept, key: 'documents/kept/copy.xml' }, tx));

    const report = await collector.collect(new Date('2026-11-13T09:00:00.000Z'));

    expect(report).toEqual({ examined: 2, removed: 1 });
    expect([...objects.objects.keys()].sort()).toEqual([recent, sha256(kept.content)].sort());
    expect(objects.objects.has(old)).toBe(false);
  });

  it('never removes an object that a unit of work holds and has not committed yet', async () => {
    const original = blob('<Invoice>in flight</Invoice>');
    const uploaded = gate();
    const commit = gate();
    const writing = db.uow.run(async (tx) => {
      await blobs.put(original, tx);
      uploaded.open();
      await commit.opened;
    });
    await uploaded.opened;

    const future = new Date('2027-01-01T00:00:00.000Z');
    expect(await collector.collect(future)).toEqual({ examined: 1, removed: 0 });
    commit.open();
    await writing;
    expect(await collector.collect(future)).toEqual({ examined: 1, removed: 0 });
    expect((await blobs.get(original.key))?.content).toEqual(original.content);
  });
});
