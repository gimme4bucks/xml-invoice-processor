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
  /** Only objects written longer ago than this are looked at. */
  minAgeMs: number;
}

export const ORPHAN_SWEEP_SETTINGS = Symbol('OrphanSweepSettings');

export function loadS3Config(_env: NodeJS.ProcessEnv): S3Config {
  throw new Error('Not implemented');
}

export function loadOrphanSweepSettings(_env: NodeJS.ProcessEnv): OrphanSweepSettings {
  throw new Error('Not implemented');
}
