import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIdp, parseClients } from './idp';

const issuer = 'http://idp.test';
const audience = 'xml-invoice-processor';
const client = {
  secret: 's3cret',
  org_id: 'org-1',
  peppol_id: '0106:11111111',
  scopes: ['documents:submit', 'documents:read'],
};

describe('mock IdP', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = await createIdp({ issuer, audience, clients: { 'client-1': client } });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
  });

  const tokenRequest = (form: Record<string, string>, basic?: string) =>
    fetch(`${base}/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(basic ? { Authorization: `Basic ${Buffer.from(basic).toString('base64')}` } : {}),
      },
      body: new URLSearchParams(form),
    });

  it('issues an ES256 token (Basic auth) that verifies against its JWKS', async () => {
    const res = await tokenRequest({ grant_type: 'client_credentials' }, 'client-1:s3cret');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { access_token: string; expires_in: number };
    expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 900 });

    const keys = createRemoteJWKSet(new URL(`${base}/.well-known/jwks.json`));
    const { payload, protectedHeader } = await jwtVerify(body.access_token, keys, {
      issuer,
      audience,
      algorithms: ['ES256'],
    });
    expect(protectedHeader.alg).toBe('ES256');
    expect(payload).toMatchObject({
      sub: 'client-1',
      org_id: 'org-1',
      peppol_id: '0106:11111111',
      scope: 'documents:submit documents:read',
    });
    expect(payload.exp! - payload.iat!).toBe(900);
  });

  it('accepts credentials in the form and narrows the scope on request', async () => {
    const res = await tokenRequest({
      grant_type: 'client_credentials',
      client_id: 'client-1',
      client_secret: 's3cret',
      scope: 'documents:read',
    });
    expect(((await res.json()) as { scope: string }).scope).toBe('documents:read');
  });

  it('rejects a wrong secret, an unknown grant type and an ungranted scope', async () => {
    const wrong = await tokenRequest({ grant_type: 'client_credentials' }, 'client-1:nope');
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({ error: 'invalid_client' });

    const grant = await tokenRequest({ grant_type: 'password' }, 'client-1:s3cret');
    expect(await grant.json()).toMatchObject({ error: 'unsupported_grant_type' });

    const scope = await tokenRequest(
      { grant_type: 'client_credentials', scope: 'admin' },
      'client-1:s3cret',
    );
    expect(scope.status).toBe(400);
    expect(await scope.json()).toMatchObject({ error: 'invalid_scope' });
  });

  it('validates MOCK_IDP_CLIENTS at startup', () => {
    expect(() => parseClients(undefined)).toThrow('MOCK_IDP_CLIENTS is required');
    expect(() => parseClients('{"c":{"secret":"x"}}')).toThrow('client "c"');
    expect(parseClients(JSON.stringify({ c: client }))).toEqual({ c: client });
  });
});
