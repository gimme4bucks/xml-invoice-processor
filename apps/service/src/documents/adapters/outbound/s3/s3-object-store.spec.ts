import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { PersistenceUnavailableError } from '../../../application/ports';
import type { S3Config } from './s3-config';
import { S3ObjectStore } from './s3-object-store';

const content = Buffer.from('<Invoice>1</Invoice>');
const sha256 = createHash('sha256').update(content).digest('hex');

/**
 * The SDK against a local HTTP server that plays the failing S3: no infrastructure needed, and
 * every fault is deterministic. The real server's behaviour is in test/contract/s3.contract.spec.ts.
 */
describe('S3ObjectStore', () => {
  let server: Server | undefined;

  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve) ?? resolve(undefined));
    server = undefined;
  });

  /** Starts a fake S3 on a free port and returns a store pointed at it. */
  async function storeAgainst(
    handle: (request: IncomingMessage, body: Buffer, response: ServerResponse) => void,
  ): Promise<S3ObjectStore> {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => handle(request, Buffer.concat(chunks), response));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return new S3ObjectStore(config(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  }

  const config = (endpoint: string): S3Config => ({
    bucket: 'documents',
    region: 'eu-central-1',
    endpoint,
    forcePathStyle: true,
    timeoutMs: 300,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });

  const s3Error = (response: ServerResponse, status: number, code: string) => {
    response.writeHead(status, { 'content-type': 'application/xml' });
    response.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code></Error>`);
  };

  it('puts the object under sha256/<hash> with its content type and a checksum the server can verify', async () => {
    const requests: Array<{ method?: string; url?: string; headers: object; body: Buffer }> = [];
    const store = await storeAgainst((request, body, response) => {
      requests.push({ method: request.method, url: request.url, headers: request.headers, body });
      response.writeHead(200).end();
    });

    await store.put(sha256, content, 'application/xml');

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: 'PUT',
      // Path-style: /bucket/key. The SDK adds an ?x-id=PutObject query of its own.
      url: expect.stringMatching(new RegExp(`^/documents/sha256/${sha256}(\\?|$)`)) as string,
      headers: {
        'content-type': 'application/xml',
        'x-amz-checksum-sha256': Buffer.from(sha256, 'hex').toString('base64'),
      },
    });
    expect(requests[0]?.body.toString()).toContain('<Invoice>1</Invoice>');
  });

  it('returns undefined for an object that does not exist (404 NoSuchKey)', async () => {
    const store = await storeAgainst((_request, _body, response) =>
      s3Error(response, 404, 'NoSuchKey'),
    );
    expect(await store.get(sha256)).toBeUndefined();
  });

  it('maps a refused connection to PersistenceUnavailableError', async () => {
    // A port that was free a moment ago: nothing listens there.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise((resolve) => probe.close(resolve));
    const refused = new S3ObjectStore(config(`http://127.0.0.1:${port}`));

    await expect(refused.put(sha256, content, 'application/xml')).rejects.toBeInstanceOf(
      PersistenceUnavailableError,
    );
    await expect(refused.get(sha256)).rejects.toBeInstanceOf(PersistenceUnavailableError);
    await expect(refused.delete(sha256)).rejects.toBeInstanceOf(PersistenceUnavailableError);
  });

  it('gives up on a server that never answers within the timeout (PersistenceUnavailableError)', async () => {
    const store = await storeAgainst(() => undefined); // accepts, reads, never answers: frozen
    const started = Date.now();
    await expect(store.put(sha256, content, 'application/xml')).rejects.toBeInstanceOf(
      PersistenceUnavailableError,
    );
    await expect(store.get(sha256)).rejects.toBeInstanceOf(PersistenceUnavailableError);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('maps a 503 (SlowDown) to PersistenceUnavailableError', async () => {
    const store = await storeAgainst((_request, _body, response) =>
      s3Error(response, 503, 'SlowDown'),
    );
    await expect(store.put(sha256, content, 'application/xml')).rejects.toBeInstanceOf(
      PersistenceUnavailableError,
    );
  });

  it('lets a refusal that is not an outage through unchanged (403 AccessDenied)', async () => {
    const store = await storeAgainst((_request, _body, response) =>
      s3Error(response, 403, 'AccessDenied'),
    );
    const error: unknown = await store
      .put(sha256, content, 'application/xml')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PersistenceUnavailableError);
    expect((error as Error).name).toBe('AccessDenied');
  });
});
