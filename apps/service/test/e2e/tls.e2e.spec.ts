import { execFile } from 'node:child_process';
import http, { type IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { rootCertificates, type TLSSocket } from 'node:tls';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { Api, clients, stack } from './support/stack';

/**
 * TLS at the edge (ADR 0013): Caddy terminates HTTPS for the API and the mock IdP, and the Node
 * processes behind it are not reachable from the host. `pnpm e2e` trusts Caddy's root certificate
 * through NODE_EXTRA_CA_CERTS (exported by `scripts/tls`); these tests show that this trust is
 * what makes the connection work, not a disabled check.
 */
const endpoints = [
  { name: 'the API', url: `${stack.apiUrl}/health` },
  { name: 'the IdP', url: `${stack.idpUrl}/.well-known/jwks.json` },
];

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  /** Only for HTTPS: whether the certificate chain was verified, and who issued the server's. */
  authorized?: boolean;
  issuer?: string | string[];
}

/** A plain GET with node:http(s), so the test controls the trusted CAs and sees redirects as-is. */
function get(url: string, options: https.RequestOptions = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const onResponse = (response: http.IncomingMessage) => {
      const socket = response.socket as Partial<TLSSocket>;
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          authorized: socket.authorized,
          issuer: socket.getPeerCertificate?.().issuer?.CN,
        }),
      );
    };
    const request = url.startsWith('https:')
      ? https.get(url, { ...options, agent: false }, onResponse)
      : http.get(url, { ...options, agent: false }, onResponse);
    request.setTimeout(10_000, () => request.destroy(new Error(`Timed out: ${url}`)));
    request.on('error', reject);
  });
}

const plainHttp = (url: string) => url.replace(/^https:/, 'http:');

const repoRoot = path.resolve(__dirname, '../../../..');

describe('TLS at the edge (e2e)', () => {
  it.each(endpoints)(
    'serves $name over HTTPS with a certificate from the exported CA',
    async ({ url }) => {
      expect(url).toMatch(/^https:\/\/localhost:(3443|4443)\//);

      // The default trust store: the public roots plus NODE_EXTRA_CA_CERTS from `pnpm e2e`.
      const response = await get(url);

      expect(response.status).toBe(200);
      expect(response.authorized).toBe(true);
      expect(response.issuer).toMatch(/^Caddy Local Authority/);
    },
  );

  it.each(endpoints)(
    'fails certificate verification for $name without that CA',
    async ({ url }) => {
      // Only the public roots that ship with Node: Caddy's local CA is not one of them.
      const failure = await get(url, { ca: [...rootCertificates] }).then(
        () => undefined,
        (error: NodeJS.ErrnoException) => error.code,
      );

      expect(failure).toBe('UNABLE_TO_GET_ISSUER_CERT_LOCALLY');
    },
  );

  it.each(endpoints)('refuses plain HTTP to $name, without a redirect', async ({ url }) => {
    const response = await get(plainHttp(url));

    // Caddy answers on the TLS port itself; the request never reaches the service behind it.
    expect(response.status).toBe(400);
    expect(response.headers.location).toBeUndefined();
    expect(response.body).toContain('HTTP request to an HTTPS server');
  });

  it('publishes the API and the IdP only through the edge', async () => {
    const { stdout } = await promisify(execFile)(
      'docker',
      ['compose', '--profile', 'full', 'config', '--format', 'json'],
      { cwd: repoRoot },
    );
    const services = (
      JSON.parse(stdout) as {
        services: Record<string, { ports?: { published?: string; target: number }[] }>;
      }
    ).services;
    const published = (service: string) =>
      (services[service]?.ports ?? []).map((port) => `${port.published}->${port.target}`);

    expect(published('api')).toEqual([]);
    expect(published('mock-idp')).toEqual([]);
    expect(published('edge').sort()).toEqual(['3443->3443', '4443->4443']);
  });

  it('runs the edge as a non-root user', async () => {
    const { stdout } = await promisify(execFile)(
      'docker',
      ['compose', '--profile', 'full', 'exec', '-T', 'edge', 'id', '-u'],
      { cwd: repoRoot },
    );

    expect(stdout.trim()).not.toBe('0');
  });

  describe('Strict-Transport-Security', () => {
    let supplier: Api;

    beforeAll(async () => {
      supplier = await Api.as(clients.supplier);
    });

    it('is sent on /health, with the short max-age of the stack', async () => {
      const response = await get(`${stack.apiUrl}/health`);

      expect(response.headers['strict-transport-security']).toBe(stack.hsts);
    });

    it('is sent on API responses, with and without a token', async () => {
      const authenticated = await supplier.get('/documents');
      const anonymous = await get(`${stack.apiUrl}/documents`);

      expect(authenticated.status).toBe(200);
      expect(authenticated.headers.get('strict-transport-security')).toBe(stack.hsts);
      expect(anonymous.status).toBe(401);
      expect(anonymous.headers['strict-transport-security']).toBe(stack.hsts);
    });
  });
});
