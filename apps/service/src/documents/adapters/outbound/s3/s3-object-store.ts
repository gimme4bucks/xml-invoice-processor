import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { OnModuleDestroy } from '@nestjs/common';
import { PersistenceUnavailableError } from '../../../application/ports';
import { ObjectStore, type StoredObject } from './object-store';
import type { S3Config } from './s3-config';

/** Every object lives under this prefix, named by the sha256 of its bytes. */
const PREFIX = 'sha256/';

/** Socket errors (node) that mean the object store is not there. */
const UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
]);
/** The SDK's own timeouts, our deadline (abort), and S3's "the request body came too slowly". */
const UNAVAILABLE_NAMES = new Set(['TimeoutError', 'AbortError', 'RequestTimeout']);

/**
 * A short, log-safe reason (an error code or HTTP status, never a message) when `error` means the
 * object store is unreachable, too slow or failing on its side (5xx); undefined for every other
 * error, such as AccessDenied or NoSuchBucket, which are configuration mistakes and must be loud.
 */
function unavailableReason(error: unknown): string | undefined {
  let cause: unknown = error;
  for (let depth = 0; typeof cause === 'object' && cause !== null && depth < 5; depth++) {
    const { code, name, $metadata } = cause as {
      code?: unknown;
      name?: unknown;
      $metadata?: { httpStatusCode?: unknown };
    };
    if (typeof code === 'string' && UNAVAILABLE_CODES.has(code)) return code;
    if (typeof name === 'string' && UNAVAILABLE_NAMES.has(name)) return name;
    const status = $metadata?.httpStatusCode;
    if (typeof status === 'number' && status >= 500) return `HTTP ${status}`;
    cause = (cause as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * The bucket on S3 or a local S3-compatible server (ADR 0016). Credentials come from the SDK's
 * default chain unless the config has them: the environment locally, an IAM role in production.
 *
 * Like the Postgres adapter, it waits a bounded time and does not retry: every call has a deadline
 * of `timeoutMs`, and an outage becomes PersistenceUnavailableError, so the API answers 503 and the
 * worker requeues. Uploads run inside a database transaction, which is why they must fail fast.
 */
export class S3ObjectStore extends ObjectStore implements OnModuleDestroy {
  private readonly client: S3Client;

  constructor(private readonly config: S3Config) {
    super();
    this.client = new S3Client({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      forcePathStyle: config.forcePathStyle,
      ...(config.credentials ? { credentials: config.credentials } : {}),
      maxAttempts: 1,
      requestHandler: { connectionTimeout: config.timeoutMs, requestTimeout: config.timeoutMs },
    });
  }

  async put(sha256: string, content: Buffer, contentType: string): Promise<void> {
    await this.guard((abortSignal) =>
      this.client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: PREFIX + sha256,
          Body: content,
          ContentType: contentType,
          // The server recomputes it and refuses an upload that was damaged on the way.
          ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'),
        }),
        { abortSignal },
      ),
    );
  }

  async get(sha256: string): Promise<Buffer | undefined> {
    try {
      return await this.guard(async (abortSignal) => {
        const response = await this.client.send(
          new GetObjectCommand({ Bucket: this.config.bucket, Key: PREFIX + sha256 }),
          { abortSignal },
        );
        return Buffer.from(await response.Body!.transformToByteArray());
      });
    } catch (error) {
      if ((error as { name?: unknown }).name === 'NoSuchKey') return undefined;
      throw error;
    }
  }

  async *list(): AsyncIterable<StoredObject> {
    let continuationToken: string | undefined;
    do {
      const page = await this.guard((abortSignal) =>
        this.client.send(
          new ListObjectsV2Command({
            Bucket: this.config.bucket,
            Prefix: PREFIX,
            ContinuationToken: continuationToken,
          }),
          { abortSignal },
        ),
      );
      for (const object of page.Contents ?? []) {
        if (!object.Key || !object.LastModified) continue;
        yield { sha256: object.Key.slice(PREFIX.length), lastModified: object.LastModified };
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
  }

  async delete(sha256: string): Promise<void> {
    await this.guard((abortSignal) =>
      this.client.send(
        new DeleteObjectCommand({ Bucket: this.config.bucket, Key: PREFIX + sha256 }),
        { abortSignal },
      ),
    );
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }

  /** One call with a deadline; "not there or too slow" becomes PersistenceUnavailableError. */
  private async guard<T>(call: (abortSignal: AbortSignal) => Promise<T>): Promise<T> {
    try {
      return await call(AbortSignal.timeout(this.config.timeoutMs));
    } catch (error) {
      const reason = unavailableReason(error);
      throw reason === undefined
        ? error
        : new PersistenceUnavailableError(`object store, ${reason}`);
    }
  }
}
