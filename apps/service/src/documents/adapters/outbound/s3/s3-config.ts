import { z } from 'zod';

/** Where the documents' bytes go when BLOB_STORE=s3 (ADR 0016). */
export interface S3Config {
  bucket: string;
  region: string;
  /** A local S3-compatible server; absent for AWS itself. */
  endpoint?: string;
  /** Path-style URLs (endpoint/bucket/key), which local servers need. */
  forcePathStyle: boolean;
  /**
   * Upper bound for one call, including connecting. The upload runs inside the caller's database
   * transaction, so it must stay well below that transaction's timeout (5 s).
   */
  timeoutMs: number;
  /** Absent in a deployment: the SDK's default chain finds them (environment, IAM role). */
  credentials?: { accessKeyId: string; secretAccessKey: string };
}

/** When the worker deletes unreferenced objects (ADR 0016). */
export interface OrphanSweepSettings {
  intervalMs: number;
  /**
   * Only objects written longer ago than this are looked at. The locks already keep the collector
   * away from uncommitted uploads; the age keeps it from even looking at objects in active use.
   */
  minAgeMs: number;
}

export const ORPHAN_SWEEP_SETTINGS = Symbol('OrphanSweepSettings');

const s3Schema = z.object({
  S3_BUCKET: z.string().min(1),
  S3_REGION: z.string().min(1),
  S3_ENDPOINT: z.url().optional(),
  S3_FORCE_PATH_STYLE: z.stringbool().default(false),
  S3_TIMEOUT_MS: z.coerce.number().int().positive().default(3_000),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
});

/**
 * Reads S3_*; a missing bucket or region is a startup error. The keys are used only when both are
 * set (the local server's demo keys); otherwise the SDK's default chain finds the credentials.
 */
export function loadS3Config(env: NodeJS.ProcessEnv): S3Config {
  const parsed = s3Schema.parse(env);
  const { S3_ACCESS_KEY_ID: accessKeyId, S3_SECRET_ACCESS_KEY: secretAccessKey } = parsed;
  return {
    bucket: parsed.S3_BUCKET,
    region: parsed.S3_REGION,
    ...(parsed.S3_ENDPOINT ? { endpoint: parsed.S3_ENDPOINT } : {}),
    forcePathStyle: parsed.S3_FORCE_PATH_STYLE,
    timeoutMs: parsed.S3_TIMEOUT_MS,
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
  };
}

const orphanSchema = z.object({
  S3_ORPHAN_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  S3_ORPHAN_MIN_AGE_MS: z.coerce.number().int().positive().default(3_600_000),
});

/** Reads S3_ORPHAN_SWEEP_INTERVAL_MS and S3_ORPHAN_MIN_AGE_MS (both an hour by default). */
export function loadOrphanSweepSettings(env: NodeJS.ProcessEnv): OrphanSweepSettings {
  const parsed = orphanSchema.parse(env);
  return {
    intervalMs: parsed.S3_ORPHAN_SWEEP_INTERVAL_MS,
    minAgeMs: parsed.S3_ORPHAN_MIN_AGE_MS,
  };
}
