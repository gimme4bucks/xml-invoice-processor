import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaBlobReferences } from '../../src/documents/adapters/outbound/postgres/prisma-blob-references';
import { PrismaUnitOfWork } from '../../src/documents/adapters/outbound/postgres/prisma-persistence';
import { PrismaService } from '../../src/documents/adapters/outbound/postgres/prisma.service';
import { OrphanObjectCollector } from '../../src/documents/adapters/outbound/s3/orphan-objects';
import type { S3Config } from '../../src/documents/adapters/outbound/s3/s3-config';
import { S3BlobStore } from '../../src/documents/adapters/outbound/s3/s3-blob-store';
import { S3ObjectStore } from '../../src/documents/adapters/outbound/s3/s3-object-store';
import type { Blob } from '../../src/documents/application/ports';
import { describeBlobStoreContract } from '../contracts/blob-store.contract';

// Same source as the Postgres contract: the environment (CI) or apps/service/.env (local).
try {
  process.loadEnvFile('.env');
} catch {
  // No .env file: rely on the environment.
}
const baseUrl = process.env.DATABASE_URL;
const endpoint = process.env.S3_ENDPOINT;
if (!baseUrl) throw new Error('DATABASE_URL is required for the S3 contract tests');
if (!endpoint) throw new Error('S3_ENDPOINT is required for the S3 contract tests');

// Every run gets its own schema and runtime login (as in postgres.contract.spec.ts) and its own
// bucket, all removed afterwards: the collector must only ever see this run's objects.
const suffix = randomBytes(6).toString('hex');
const schema = `contract_${suffix}`;
const appUser = `contract_app_${suffix}`;
const appPassword = randomBytes(18).toString('hex');
const ownerUrl = new URL(baseUrl);
ownerUrl.searchParams.set('schema', schema);
const appUrl = new URL(ownerUrl);
appUrl.username = appUser;
appUrl.password = appPassword;

const { S3_ACCESS_KEY_ID: accessKeyId, S3_SECRET_ACCESS_KEY: secretAccessKey } = process.env;
const config: S3Config = {
  bucket: `contract-${suffix}`,
  region: process.env.S3_REGION ?? 'eu-central-1',
  endpoint,
  forcePathStyle: true,
  timeoutMs: 3_000,
  ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
};
/** Goes around the adapter: creates and empties the bucket, and damages objects. */
const admin = new S3Client({
  region: config.region,
  endpoint,
  forcePathStyle: true,
  credentials: config.credentials,
});

let owner: PrismaService;
let app: PrismaService;
let objects: S3ObjectStore;
let blobs: S3BlobStore;
let uow: PrismaUnitOfWork;
let references: PrismaBlobReferences;

beforeAll(async () => {
  execFileSync('pnpm', ['prisma:migrate'], {
    env: { ...process.env, DATABASE_URL: ownerUrl.toString() },
    stdio: 'pipe',
  });
  owner = new PrismaService(ownerUrl.toString());
  await owner.$executeRawUnsafe(
    `CREATE ROLE ${appUser} LOGIN PASSWORD '${appPassword}' IN ROLE xip_app`,
  );
  await admin.send(new CreateBucketCommand({ Bucket: config.bucket }));
  app = new PrismaService(appUrl.toString());
  await app.$connect();
  objects = new S3ObjectStore(config);
  references = new PrismaBlobReferences(app);
  blobs = new S3BlobStore(objects, references);
  uow = new PrismaUnitOfWork(app);
}, 60_000);

afterAll(async () => {
  await emptyBucket();
  await admin.send(new DeleteBucketCommand({ Bucket: config.bucket }));
  admin.destroy();
  objects.onModuleDestroy();
  await app.$disconnect();
  await owner.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
  await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS ${appUser}`);
  await owner.$disconnect();
});

async function objectKeys(): Promise<string[]> {
  const page = await admin.send(new ListObjectsV2Command({ Bucket: config.bucket }));
  return (page.Contents ?? []).map((object) => object.Key!);
}

async function emptyBucket(): Promise<void> {
  for (const Key of await objectKeys()) {
    await admin.send(new DeleteObjectCommand({ Bucket: config.bucket, Key }));
  }
}

async function reset(): Promise<void> {
  await owner.$executeRawUnsafe(`TRUNCATE "${schema}"."blobs"`);
  await emptyBucket();
}

const sha256 = (content: Buffer) => createHash('sha256').update(content).digest('hex');

const blob = (text: string): Blob => ({
  key: `documents/${randomUUID()}/original.xml`,
  contentType: 'application/xml',
  content: Buffer.from(text, 'utf8'),
});

/** A promise and the function that resolves it, to hold a unit of work open at a known point. */
function gate(): { opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

/** Polls a condition every 20 ms until it holds (never a fixed sleep), failing after 5 s. */
async function until(condition: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('Condition not met within 5 s');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const collectAll = () =>
  new OrphanObjectCollector(objects, references).collect(new Date(Date.now() + 3_600_000));

describeBlobStoreContract('s3 (Versity S3 Gateway + Postgres)', async () => ({
  uow,
  blobs,
  corrupt: async (key) => {
    const row = await owner.blob.findUniqueOrThrow({ where: { key } });
    await admin.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: `sha256/${row.sha256}`,
        Body: Buffer.from('<Invoice>tampered</Invoice>'),
      }),
    );
  },
  reset,
}));

describe('s3: the bytes in the bucket, the reference in Postgres', () => {
  beforeEach(reset);

  it('stores the bytes under sha256/<hash> and only the reference in the blobs table', async () => {
    const original = blob('<Invoice>in the bucket</Invoice>');
    await uow.run((tx) => blobs.put(original, tx));
    expect(await objectKeys()).toEqual([`sha256/${sha256(original.content)}`]);
    expect(await owner.blob.findUnique({ where: { key: original.key } })).toMatchObject({
      contentType: 'application/xml',
      sha256: sha256(original.content),
      content: null,
    });
  });

  it('reports a referenced object that is gone from the bucket as an error, not as missing', async () => {
    const original = blob('<Invoice>lost</Invoice>');
    await uow.run((tx) => blobs.put(original, tx));
    await emptyBucket();
    await expect(blobs.get(original.key)).rejects.toThrow(/missing from the bucket/);
  });

  it('collects the object of a rolled-back unit of work and keeps the referenced ones', async () => {
    const kept = blob('<Invoice>kept</Invoice>');
    const orphan = blob('<Invoice>orphan</Invoice>');
    await uow.run((tx) => blobs.put(kept, tx));
    await expect(
      uow.run(async (tx) => {
        await blobs.put(orphan, tx);
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    expect(await objectKeys()).toHaveLength(2);

    expect(await collectAll()).toEqual({ examined: 2, removed: 1 });
    expect(await objectKeys()).toEqual([`sha256/${sha256(kept.content)}`]);
    expect((await blobs.get(kept.key))?.content).toEqual(kept.content);
  });

  it('never collects an object whose writer has uploaded it but not committed yet', async () => {
    const original = blob('<Invoice>in flight</Invoice>');
    const uploaded = gate();
    const commit = gate();
    const writing = uow.run(async (tx) => {
      await blobs.put(original, tx);
      uploaded.open();
      await commit.opened;
    });
    await uploaded.opened;

    expect(await collectAll()).toEqual({ examined: 1, removed: 0 });
    commit.open();
    await writing;
    expect((await blobs.get(original.key))?.content).toEqual(original.content);
  });

  it('makes a writer of the same bytes wait while the collector deletes, then upload again', async () => {
    const original = blob('<Invoice>again</Invoice>');
    await expect(
      uow.run(async (tx) => {
        await blobs.put(original, tx);
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    const hash = sha256(original.content);

    const deleting = gate();
    const proceed = gate();
    const collecting = references.removeIfUnreferenced(hash, async () => {
      deleting.open();
      await proceed.opened;
      await objects.delete(hash);
    });
    await deleting.opened;
    const writing = uow.run((tx) => blobs.put(original, tx));
    // The writer is blocked on the collector's lock, not uploading.
    await until(async () => {
      const [{ waiting }] = await owner.$queryRaw<[{ waiting: number }]>`
        SELECT count(*)::int AS waiting FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`;
      return waiting === 1;
    });

    proceed.open();
    expect(await collecting).toBe(true);
    await writing;
    expect(await objectKeys()).toEqual([`sha256/${hash}`]);
    expect((await blobs.get(original.key))?.content).toEqual(original.content);
  });
});
