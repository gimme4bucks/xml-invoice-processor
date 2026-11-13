import type { Provider } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ProcessRole, realProviders } from '../../src/app/adapters';
import { PrismaBlobReferences } from '../../src/documents/adapters/outbound/postgres/prisma-blob-references';
import { PrismaBlobStore } from '../../src/documents/adapters/outbound/postgres/prisma-persistence';
import { BlobReferences } from '../../src/documents/adapters/outbound/s3/blob-references';
import { ObjectStore } from '../../src/documents/adapters/outbound/s3/object-store';
import {
  OrphanObjectCollector,
  OrphanSweepLoop,
} from '../../src/documents/adapters/outbound/s3/orphan-objects';
import { S3BlobStore } from '../../src/documents/adapters/outbound/s3/s3-blob-store';
import {
  loadOrphanSweepSettings,
  loadS3Config,
} from '../../src/documents/adapters/outbound/s3/s3-config';
import { BlobStore } from '../../src/documents/application/ports';
import { loadConfig } from '../../src/shared/config';

const config = loadConfig({
  ADAPTERS: 'real',
  DATABASE_URL: 'postgresql://xip:xip@localhost:5432/xip',
  AMQP_URL: 'amqp://localhost',
});
const s3Env = { BLOB_STORE: 's3', S3_BUCKET: 'documents', S3_REGION: 'eu-central-1' };

/** The bindings of `token` (no Nest container needed: nothing connects). */
const bindings = (providers: Provider[], token: unknown) =>
  providers.filter((p) => (typeof p === 'function' ? p : p.provide) === token);
const useClassOf = (providers: Provider[], token: unknown) =>
  bindings(providers, token).map((p) => (p as { useClass?: unknown }).useClass);
const providersFor = (role: ProcessRole, env: NodeJS.ProcessEnv) =>
  realProviders(config, role, { ...env, AMQP_URL: 'amqp://localhost' });

describe('BLOB_STORE: where the documents go', () => {
  it('keeps them in Postgres by default', () => {
    const providers = providersFor('api', {});
    expect(useClassOf(providers, BlobStore)).toEqual([PrismaBlobStore]);
    expect(bindings(providers, ObjectStore)).toEqual([]);
  });

  it('BLOB_STORE=s3 binds the S3 BlobStore, over the bucket and the Postgres references, instead', () => {
    for (const role of ['api', 'worker'] as const) {
      const providers = providersFor(role, s3Env);
      expect(useClassOf(providers, BlobStore)).toEqual([S3BlobStore]);
      expect(useClassOf(providers, BlobReferences)).toEqual([PrismaBlobReferences]);
      expect(bindings(providers, ObjectStore)).toHaveLength(1);
    }
  });

  it('runs the orphan sweep in the worker only', () => {
    expect(bindings(providersFor('worker', s3Env), OrphanSweepLoop)).toHaveLength(1);
    expect(bindings(providersFor('worker', s3Env), OrphanObjectCollector)).toHaveLength(1);
    expect(bindings(providersFor('api', s3Env), OrphanSweepLoop)).toEqual([]);
    expect(bindings(providersFor('worker', {}), OrphanSweepLoop)).toEqual([]);
  });

  it('refuses an unknown BLOB_STORE at startup', () => {
    expect(() => providersFor('api', { BLOB_STORE: 'disk' })).toThrow(/BLOB_STORE/);
  });

  it('BLOB_STORE=s3 needs a bucket and a region at startup', () => {
    expect(() => providersFor('api', { BLOB_STORE: 's3', S3_REGION: 'eu-central-1' })).toThrow(
      /S3_BUCKET/,
    );
    expect(() => providersFor('api', { BLOB_STORE: 's3', S3_BUCKET: 'documents' })).toThrow(
      /S3_REGION/,
    );
  });
});

describe('S3 settings', () => {
  it('reads the bucket, region, endpoint and path style, with a 3 s deadline per call', () => {
    expect(
      loadS3Config({
        ...s3Env,
        S3_ENDPOINT: 'http://s3:7070',
        S3_FORCE_PATH_STYLE: 'true',
        S3_TIMEOUT_MS: '2000',
      }),
    ).toEqual({
      bucket: 'documents',
      region: 'eu-central-1',
      endpoint: 'http://s3:7070',
      forcePathStyle: true,
      timeoutMs: 2_000,
    });
    expect(loadS3Config(s3Env)).toEqual({
      bucket: 'documents',
      region: 'eu-central-1',
      forcePathStyle: false,
      timeoutMs: 3_000,
    });
  });

  it('passes keys only when both are set; otherwise the SDK finds them (IAM role)', () => {
    const keys = { S3_ACCESS_KEY_ID: 'id', S3_SECRET_ACCESS_KEY: 'secret' };
    expect(loadS3Config({ ...s3Env, ...keys }).credentials).toEqual({
      accessKeyId: 'id',
      secretAccessKey: 'secret',
    });
    expect(loadS3Config({ ...s3Env, S3_ACCESS_KEY_ID: 'id' }).credentials).toBeUndefined();
  });

  it('sweeps for orphans every hour, for objects older than an hour, unless told otherwise', () => {
    expect(loadOrphanSweepSettings({})).toEqual({ intervalMs: 3_600_000, minAgeMs: 3_600_000 });
    expect(
      loadOrphanSweepSettings({
        S3_ORPHAN_SWEEP_INTERVAL_MS: '60000',
        S3_ORPHAN_MIN_AGE_MS: '600000',
      }),
    ).toEqual({ intervalMs: 60_000, minAgeMs: 600_000 });
  });
});

describe('OrphanSweepLoop', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('collects the objects older than the minimum age once per interval, and goes on after a failed run', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-13T12:00:00.000Z') });
    const collect = vi
      .fn<OrphanObjectCollector['collect']>()
      .mockRejectedValueOnce(new Error('object store down'))
      .mockResolvedValue({ examined: 3, removed: 1 });
    const loop = new OrphanSweepLoop({ collect } as unknown as OrphanObjectCollector, {
      intervalMs: 60_000,
      minAgeMs: 3_600_000,
    });

    loop.onApplicationBootstrap();
    expect(collect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(collect).toHaveBeenCalledWith(new Date('2026-11-13T11:01:00.000Z'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(collect).toHaveBeenCalledTimes(2);
    loop.onApplicationShutdown();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(collect).toHaveBeenCalledTimes(2);
  });
});
