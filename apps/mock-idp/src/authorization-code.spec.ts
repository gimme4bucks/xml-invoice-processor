import { createHash, randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createIdp, parseSupportClient } from './idp';

/**
 * Authorization Code + PKCE (RFC 6749 §4.1, RFC 7636, RFC 9700) for the public client
 * `support-web`. The clock is injected, so code expiry is tested without waiting.
 */
const issuer = 'http://idp.test';
const audience = 'xml-invoice-processor';
const redirectUri = 'https://support.test/callback';
const otherRedirectUri = 'https://support.test/other-callback';
const user = { username: 'support-alice', password: 'correct horse' };

const base64url = (bytes: Buffer) => bytes.toString('base64url');
const newVerifier = () => base64url(randomBytes(32));
const challengeOf = (verifier: string) => base64url(createHash('sha256').update(verifier).digest());

describe('mock IdP: Authorization Code + PKCE', () => {
  let server: Server;
  let base: string;
  let now = Date.parse('2026-11-13T10:00:00.000Z');

  beforeAll(async () => {
    server = await createIdp({
      issuer,
      audience,
      clients: {
        'client-1': {
          secret: 's3cret',
          org_id: 'org-1',
          peppol_id: '0106:11111111',
          scopes: ['documents:read'],
        },
      },
      support: {
        redirectUris: [redirectUri, otherRedirectUri],
        users: { [user.username]: { password: user.password } },
      },
      now: () => now,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
  });
  beforeEach(() => {
    now = Date.parse('2026-11-13T10:00:00.000Z');
  });

  interface Flow {
    verifier: string;
    params: Record<string, string>;
  }

  const newFlow = (overrides: Record<string, string | undefined> = {}): Flow => {
    const verifier = newVerifier();
    const params: Record<string, string> = {};
    const all: Record<string, string | undefined> = {
      response_type: 'code',
      client_id: 'support-web',
      redirect_uri: redirectUri,
      state: base64url(randomBytes(16)),
      code_challenge: challengeOf(verifier),
      code_challenge_method: 'S256',
      scope: 'support:read',
      ...overrides,
    };
    for (const [key, value] of Object.entries(all)) if (value !== undefined) params[key] = value;
    return { verifier, params };
  };

  const authorize = (params: Record<string, string>) =>
    fetch(`${base}/authorize?${new URLSearchParams(params)}`, { redirect: 'manual' });

  const login = (params: Record<string, string>, credentials = user) =>
    fetch(`${base}/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...params, ...credentials }),
      redirect: 'manual',
    });

  const token = (form: Record<string, string>, headers: Record<string, string> = {}) =>
    fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(form),
    });

  /** Logs in and returns the code from the redirect back to the client. */
  async function codeFor(flow: Flow): Promise<string> {
    const res = await login(flow.params);
    expect(res.status).toBe(303);
    const location = new URL(res.headers.get('location')!);
    expect(location.searchParams.get('state')).toBe(flow.params.state);
    return location.searchParams.get('code')!;
  }

  const redeem = (flow: Flow, code: string, overrides: Record<string, string> = {}) =>
    token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: flow.params.redirect_uri!,
      client_id: 'support-web',
      code_verifier: flow.verifier,
      ...overrides,
    });

  it('shows a login form, redirects back with code and state, and issues a support token', async () => {
    const flow = newFlow();
    const form = await authorize(flow.params);
    expect(form.status).toBe(200);
    expect(form.headers.get('content-type')).toMatch(/^text\/html/);
    expect(form.headers.get('cache-control')).toBe('no-store');
    expect(form.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(form.headers.get('x-frame-options')).toBe('DENY');
    const html = await form.text();
    expect(html).toContain('name="password"');
    expect(html).toContain(`value="${flow.params.state}"`);

    const loggedIn = await login(flow.params);
    expect(loggedIn.status).toBe(303);
    const location = new URL(loggedIn.headers.get('location')!);
    expect(`${location.origin}${location.pathname}`).toBe(redirectUri);
    expect(location.searchParams.get('state')).toBe(flow.params.state);
    expect(location.searchParams.get('iss')).toBe(issuer);
    const code = location.searchParams.get('code')!;
    expect(code).toMatch(/^[A-Za-z0-9_-]{43,}$/);

    const res = await redeem(flow, code);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { access_token: string; scope: string; token_type: string };
    expect(body).toMatchObject({ token_type: 'Bearer', scope: 'support:read' });

    const keys = createRemoteJWKSet(new URL(`${base}/.well-known/jwks.json`));
    const { payload } = await jwtVerify(body.access_token, keys, {
      issuer,
      audience,
      algorithms: ['ES256'],
    });
    expect(payload).toMatchObject({ sub: user.username, scope: 'support:read' });
    expect(payload).not.toHaveProperty('org_id');
    expect(payload).not.toHaveProperty('peppol_id');
    expect(payload.exp).toEqual(expect.any(Number));
  });

  it('refuses a wrong code_verifier', async () => {
    const flow = newFlow();
    const res = await redeem(flow, await codeFor(flow), { code_verifier: newVerifier() });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('refuses a code that was already used, even after a failed attempt', async () => {
    const flow = newFlow();
    const code = await codeFor(flow);
    expect((await redeem(flow, code)).status).toBe(200);
    const reused = await redeem(flow, code);
    expect(reused.status).toBe(400);
    expect(await reused.json()).toMatchObject({ error: 'invalid_grant' });

    // A wrong verifier burns the code too, so a verifier cannot be guessed in several tries.
    const other = newFlow();
    const burnt = await codeFor(other);
    expect((await redeem(other, burnt, { code_verifier: newVerifier() })).status).toBe(400);
    expect((await redeem(other, burnt)).status).toBe(400);
  });

  it('refuses a code older than 60 seconds', async () => {
    const fresh = newFlow();
    const freshCode = await codeFor(fresh);
    now += 59_000;
    expect((await redeem(fresh, freshCode)).status).toBe(200);

    const flow = newFlow();
    const code = await codeFor(flow);
    now += 61_000;
    const res = await redeem(flow, code);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('binds the code to its client and its redirect URI', async () => {
    const flow = newFlow();
    const otherUri = await redeem(flow, await codeFor(flow), { redirect_uri: otherRedirectUri });
    expect(otherUri.status).toBe(400);
    expect(await otherUri.json()).toMatchObject({ error: 'invalid_grant' });

    const second = newFlow();
    const otherClient = await redeem(second, await codeFor(second), { client_id: 'client-1' });
    expect(otherClient.status).toBe(400);
    expect(((await otherClient.json()) as { error: string }).error).toMatch(
      /^(invalid_grant|unauthorized_client)$/,
    );
  });

  it.each([
    ['an unknown redirect URI', 'https://evil.test/callback'],
    ['a longer path', `${redirectUri}/more`],
    ['an extra query', `${redirectUri}?next=https://evil.test`],
    ['another scheme', redirectUri.replace('https:', 'http:')],
    ['another port', 'https://support.test:8443/callback'],
  ])('shows an error page and never redirects for %s', async (_case, uri) => {
    const flow = newFlow({ redirect_uri: uri });
    for (const res of [await authorize(flow.params), await login(flow.params)]) {
      expect(res.status).toBe(400);
      expect(res.headers.get('location')).toBeNull();
      expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    }
  });

  it('shows an error page and never redirects for an unknown client', async () => {
    const res = await authorize(newFlow({ client_id: 'client-1' }).params);
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });

  it('requires state: the client cannot tie the answer to its request without it', async () => {
    const flow = newFlow({ state: undefined });
    for (const res of [await authorize(flow.params), await login(flow.params)]) {
      expect(res.status).toBe(303);
      const location = new URL(res.headers.get('location')!);
      expect(location.searchParams.get('error')).toBe('invalid_request');
      expect(location.searchParams.get('code')).toBeNull();
    }
  });

  it.each([
    ['plain', { code_challenge_method: 'plain' }],
    ['a missing method', { code_challenge_method: undefined }],
    ['a missing challenge', { code_challenge: undefined }],
    ['a malformed challenge', { code_challenge: 'too-short' }],
  ])('refuses %s: only S256 challenges', async (_case, overrides) => {
    const flow = newFlow(overrides);
    for (const res of [await authorize(flow.params), await login(flow.params)]) {
      expect(res.status).toBe(303);
      const location = new URL(res.headers.get('location')!);
      expect(location.searchParams.get('error')).toBe('invalid_request');
      expect(location.searchParams.get('state')).toBe(flow.params.state);
      expect(location.searchParams.get('code')).toBeNull();
    }
  });

  it('refuses another response_type and another scope', async () => {
    const implicit = await authorize(newFlow({ response_type: 'token' }).params);
    expect(implicit.status).toBe(303);
    expect(new URL(implicit.headers.get('location')!).searchParams.get('error')).toBe(
      'unsupported_response_type',
    );
    const scope = await authorize(newFlow({ scope: 'documents:read' }).params);
    expect(scope.status).toBe(303);
    expect(new URL(scope.headers.get('location')!).searchParams.get('error')).toBe('invalid_scope');
  });

  it('shows the form again for a wrong password, without a redirect', async () => {
    const res = await login(newFlow().params, { ...user, password: 'wrong' });
    expect(res.status).toBe(401);
    expect(res.headers.get('location')).toBeNull();
    const html = await res.text();
    expect(html).toContain('name="password"');
    expect(html).not.toContain('wrong');
  });

  it('escapes every reflected value in the login form', async () => {
    const flow = newFlow({ state: '"><script>alert(1)</script>' });
    const html = await (await authorize(flow.params)).text();
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('answers CORS on /token only for the origins of the allowed redirect URIs', async () => {
    const flow = newFlow();
    const withoutOrigin = await redeem(flow, await codeFor(flow));
    expect(withoutOrigin.headers.get('access-control-allow-origin')).toBeNull();

    const second = newFlow();
    const code = await codeFor(second);
    const fromApp = await token(
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: 'support-web',
        code_verifier: second.verifier,
      },
      { Origin: 'https://support.test' },
    );
    expect(fromApp.status).toBe(200);
    expect(fromApp.headers.get('access-control-allow-origin')).toBe('https://support.test');
    expect(fromApp.headers.get('access-control-allow-credentials')).toBeNull();
    expect(fromApp.headers.get('vary')).toContain('Origin');

    const evil = await token({ grant_type: 'authorization_code' }, { Origin: 'https://evil.test' });
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();

    const preflight = await fetch(`${base}/token`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://support.test',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://support.test');
    expect(preflight.headers.get('access-control-allow-methods')).toBe('POST');
    const refused = await fetch(`${base}/token`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.test', 'Access-Control-Request-Method': 'POST' },
    });
    expect(refused.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('keeps the client-credentials grant unchanged', async () => {
    const res = await token({
      grant_type: 'client_credentials',
      client_id: 'client-1',
      client_secret: 's3cret',
    });
    expect(res.status).toBe(200);
  });

  it('validates the support client settings at startup', () => {
    expect(parseSupportClient(undefined, undefined)).toBeUndefined();
    expect(parseSupportClient(redirectUri, JSON.stringify({ alice: { password: 'pw' } }))).toEqual({
      redirectUris: [redirectUri],
      users: { alice: { password: 'pw' } },
    });
    expect(() => parseSupportClient(redirectUri, undefined)).toThrow('MOCK_IDP_SUPPORT_USERS');
    expect(() => parseSupportClient('not a url', '{"a":{"password":"p"}}')).toThrow(
      'MOCK_IDP_SUPPORT_REDIRECT_URIS',
    );
    expect(() => parseSupportClient(`${redirectUri}#frag`, '{"a":{"password":"p"}}')).toThrow(
      'MOCK_IDP_SUPPORT_REDIRECT_URIS',
    );
    expect(() => parseSupportClient(redirectUri, '{"a":{"password":""}}')).toThrow('user "a"');
  });
});
