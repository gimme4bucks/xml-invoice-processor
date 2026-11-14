import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIdp, parseCorsOrigins } from './idp';

/**
 * The API's Swagger UI (G15, ADR 0019) asks for a client-credentials token from the browser: a
 * cross-origin POST to /token with the client in a Basic header (Swagger UI's only option for this
 * flow), `X-Requested-With`, and `scope=` empty when the tester ticks no scope.
 */
const apiOrigin = 'https://api.test';
const client = {
  secret: 's3cret',
  org_id: 'org-1',
  peppol_id: '0106:11111111',
  scopes: ['documents:submit', 'documents:read'],
};

describe('mock IdP: the Swagger UI token request', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = await createIdp({
      issuer: 'http://idp.test',
      audience: 'xml-invoice-processor',
      clients: { 'client-1': client },
      corsOrigins: [apiOrigin],
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
  });

  const preflight = (origin: string) =>
    fetch(`${base}/token`, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type,x-requested-with',
      },
    });

  /** Exactly what Swagger UI 5 sends: btoa(id + ":" + secret), not form-encoded first. */
  const swaggerTokenRequest = (scope: string, origin = apiOrigin) =>
    fetch(`${base}/token`, {
      method: 'POST',
      headers: {
        Origin: origin,
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
        Authorization: `Basic ${btoa('client-1:s3cret')}`,
      },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope }),
    });

  it('allows the preflight from a configured origin, with the headers Swagger UI sends', async () => {
    const res = await preflight(apiOrigin);

    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(apiOrigin);
    expect(res.headers.get('access-control-allow-methods')).toBe('POST');
    const allowed = res.headers.get('access-control-allow-headers')?.toLowerCase().split(/,\s*/);
    expect(allowed).toEqual(
      expect.arrayContaining(['authorization', 'content-type', 'x-requested-with']),
    );
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('answers no CORS for any other origin, not even a prefix or another scheme', async () => {
    for (const origin of ['https://evil.test', 'https://api.test.evil.test', 'http://api.test']) {
      const res = await preflight(origin);
      expect(res.headers.get('access-control-allow-origin'), origin).toBeNull();
      const token = await swaggerTokenRequest('', origin);
      expect(token.headers.get('access-control-allow-origin'), origin).toBeNull();
    }
  });

  it('issues a token with CORS for the configured origin', async () => {
    const res = await swaggerTokenRequest('documents:submit documents:read');

    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(apiOrigin);
    expect(res.headers.get('vary')).toContain('Origin');
  });

  it("gives the client's scopes when Swagger UI sends an empty scope", async () => {
    const res = await swaggerTokenRequest('');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token: string; scope: string };
    expect(body.scope).toBe('documents:submit documents:read');
    expect(decodeJwt(body.access_token).scope).toBe('documents:submit documents:read');
  });

  it('validates MOCK_IDP_CORS_ORIGINS at startup: exact origins only', () => {
    expect(parseCorsOrigins(undefined)).toEqual([]);
    expect(parseCorsOrigins('')).toEqual([]);
    expect(parseCorsOrigins('https://api.test, https://localhost:3443')).toEqual([
      'https://api.test',
      'https://localhost:3443',
    ]);
    for (const bad of ['https://api.test/', 'https://api.test/docs', '*', 'api.test']) {
      expect(() => parseCorsOrigins(bad), bad).toThrow('MOCK_IDP_CORS_ORIGINS');
    }
  });
});
