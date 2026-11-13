import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { postgresProviders } from '../../src/documents/adapters/outbound/postgres/postgres-providers';
import {
  PrismaBlobStore,
  PrismaDocumentViews,
  PrismaEventStore,
  PrismaIdempotencyRegistry,
  PrismaOutbox,
  PrismaUnitOfWork,
} from '../../src/documents/adapters/outbound/postgres/prisma-persistence';
import { PrismaService } from '../../src/documents/adapters/outbound/postgres/prisma.service';
import {
  BlobStore,
  DocumentViews,
  EventStore,
  IdempotencyRegistry,
  Outbox,
  UnitOfWork,
} from '../../src/documents/application/ports';
import { describeBlobStoreContract } from '../contracts/blob-store.contract';
import { describePersistenceContract } from '../contracts/persistence.contract';

// Same source as prisma.config.ts: the environment (CI) or apps/service/.env (local).
try {
  process.loadEnvFile('.env');
} catch {
  // No .env file: rely on the environment.
}
const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) throw new Error('DATABASE_URL is required for the Postgres contract tests');

// Every run gets its own schema, migrated with the real migrations and dropped afterwards, and
// its own login role in the least-privilege runtime role xip_app (dropped afterwards too).
const suffix = randomBytes(6).toString('hex');
const schema = `contract_${suffix}`;
const appUser = `contract_app_${suffix}`;
const appPassword = randomBytes(18).toString('hex');

const ownerUrl = new URL(baseUrl);
ownerUrl.searchParams.set('schema', schema);
const appUrl = new URL(ownerUrl);
appUrl.username = appUser;
appUrl.password = appPassword;

/** The schema owner: runs migrations, resets tables and cleans up. */
let owner: PrismaService;

beforeAll(async () => {
  execFileSync('pnpm', ['prisma:migrate'], {
    env: { ...process.env, DATABASE_URL: ownerUrl.toString() },
    stdio: 'pipe',
  });
  owner = new PrismaService(ownerUrl.toString());
  await owner.$executeRawUnsafe(
    `CREATE ROLE ${appUser} LOGIN PASSWORD '${appPassword}' IN ROLE xip_app`,
  );
}, 60_000);

afterAll(async () => {
  await owner.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
  await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS ${appUser}`);
  await owner.$disconnect();
});

// The adapters run as the application would: with the runtime role's privileges only.
describePersistenceContract('postgres', async () => {
  const prisma = new PrismaService(appUrl.toString());
  await prisma.$connect();
  return {
    uow: new PrismaUnitOfWork(prisma),
    events: new PrismaEventStore(prisma),
    views: new PrismaDocumentViews(prisma),
    blobs: new PrismaBlobStore(prisma),
    outbox: new PrismaOutbox(prisma),
    idempotency: new PrismaIdempotencyRegistry(prisma),
    // The append-only trigger also blocks TRUNCATE; replica mode skips triggers (test-only).
    // Tables are schema-qualified so a mistake can never empty the shared dev database.
    reset: async () => {
      const tables = ['events', 'outbox', 'document_views', 'idempotency_records', 'blobs'];
      await owner.$transaction([
        owner.$executeRaw`SET LOCAL session_replication_role = replica`,
        owner.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${schema}"."${t}"`).join(', ')}`),
      ]);
    },
    close: () => prisma.$disconnect(),
  };
});

describeBlobStoreContract('postgres', async () => {
  const prisma = new PrismaService(appUrl.toString());
  await prisma.$connect();
  return {
    uow: new PrismaUnitOfWork(prisma),
    blobs: new PrismaBlobStore(prisma),
    corrupt: async (key) => {
      await owner.blob.update({
        where: { key },
        data: { content: new Uint8Array(Buffer.from('<Invoice>tampered</Invoice>')) },
      });
    },
    reset: async () => {
      await owner.$executeRawUnsafe(`TRUNCATE "${schema}"."blobs"`);
    },
    close: () => prisma.$disconnect(),
  };
});

describe('postgres: database guarantees and wiring', () => {
  const appendOneEvent = async (prisma: PrismaService): Promise<string> => {
    const id = randomUUID();
    await new PrismaUnitOfWork(prisma).run((tx) =>
      new PrismaEventStore(prisma).append(
        id,
        0,
        [{ type: 'ProcessingStarted', attempt: 1, startedAt: '2026-11-12T10:00:00.000Z' }],
        { correlationId: 'corr-1' },
        tx,
      ),
    );
    return id;
  };

  it('blocks updating or deleting an event even for the owner (trigger)', async () => {
    const id = await appendOneEvent(owner);
    await expect(
      owner.event.updateMany({ where: { streamId: id }, data: { type: 'Tampered' } }),
    ).rejects.toThrow(/append-only/);
    await expect(owner.event.deleteMany({ where: { streamId: id } })).rejects.toThrow(
      /append-only/,
    );
  });

  it('gives the runtime role no UPDATE, DELETE or TRUNCATE on events (privileges)', async () => {
    const app = new PrismaService(appUrl.toString());
    try {
      const id = await appendOneEvent(app);
      expect(await new PrismaEventStore(app).load(id)).toHaveLength(1);
      await expect(
        app.event.updateMany({ where: { streamId: id }, data: { type: 'Tampered' } }),
      ).rejects.toThrow(/permission denied/i);
      await expect(app.event.deleteMany({ where: { streamId: id } })).rejects.toThrow(
        /permission denied/i,
      );
      await expect(app.$executeRaw`TRUNCATE events`).rejects.toThrow(/permission denied/i);
    } finally {
      await app.$disconnect();
    }
  });

  it('postgresProviders binds every persistence port and follows the Nest lifecycle', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: postgresProviders(appUrl.toString()),
    }).compile();
    await moduleRef.init();
    try {
      expect(moduleRef.get(UnitOfWork)).toBeInstanceOf(PrismaUnitOfWork);
      expect(moduleRef.get(EventStore)).toBeInstanceOf(PrismaEventStore);
      expect(moduleRef.get(DocumentViews)).toBeInstanceOf(PrismaDocumentViews);
      expect(moduleRef.get(BlobStore)).toBeInstanceOf(PrismaBlobStore);
      expect(moduleRef.get(Outbox)).toBeInstanceOf(PrismaOutbox);
      expect(moduleRef.get(IdempotencyRegistry)).toBeInstanceOf(PrismaIdempotencyRegistry);
      const key = `wiring/${randomUUID()}`;
      await moduleRef
        .get(UnitOfWork)
        .run((tx) =>
          moduleRef
            .get(BlobStore)
            .put({ key, contentType: 'text/plain', content: Buffer.from('ok') }, tx),
        );
      expect((await moduleRef.get(BlobStore).get(key))?.content.toString()).toBe('ok');
    } finally {
      await moduleRef.close();
    }
  });
});
