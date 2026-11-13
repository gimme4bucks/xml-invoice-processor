import { createHash, randomBytes } from 'node:crypto';
import { expect } from 'vitest';
import { stack } from './stack';

/**
 * The support app's side of Authorization Code + PKCE (ADR 0017), as a browser would do it: a
 * fresh verifier and state, the mock IdP's login form, the redirect back with the code (read from
 * `Location`, never followed: the app's origin does not exist in the stack) and the token request
 * with the verifier and no secret. Defaults are the compose stack's.
 */
export const supportApp = {
  clientId: 'support-web',
  redirectUri: process.env.SUPPORT_REDIRECT_URI ?? 'https://localhost:5443/callback',
  origin: new URL(process.env.SUPPORT_REDIRECT_URI ?? 'https://localhost:5443/callback').origin,
  user: {
    username: process.env.SUPPORT_USERNAME ?? 'support-agent',
    password: process.env.SUPPORT_PASSWORD ?? 'change-me',
  },
};

export interface SupportLogin {
  accessToken: string;
  /** The redeemed code: a second redemption must fail. */
  code: string;
  verifier: string;
}

export async function supportLogin(): Promise<SupportLogin> {
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(16).toString('base64url');
  const params = {
    response_type: 'code',
    client_id: supportApp.clientId,
    redirect_uri: supportApp.redirectUri,
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    scope: 'support:read',
  };

  const form = await fetch(`${stack.idpUrl}/authorize?${new URLSearchParams(params).toString()}`);
  expect(form.status).toBe(200);
  expect(await form.text()).toContain('name="password"');

  const login = await fetch(`${stack.idpUrl}/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...params, ...supportApp.user }),
    redirect: 'manual',
  });
  expect(login.status).toBe(303);
  const callback = new URL(login.headers.get('location') ?? '');
  expect(`${callback.origin}${callback.pathname}`).toBe(supportApp.redirectUri);
  expect(callback.searchParams.get('state')).toBe(state);
  const code = callback.searchParams.get('code') ?? '';

  const token = await redeem(code, verifier);
  expect(token.status).toBe(200);
  expect(token.headers.get('access-control-allow-origin')).toBe(supportApp.origin);
  const { access_token: accessToken } = (await token.json()) as { access_token: string };
  return { accessToken, code, verifier };
}

/** The token request of the browser app: from its origin, with the verifier and no secret. */
export function redeem(code: string, verifier: string): Promise<Response> {
  return fetch(`${stack.idpUrl}/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: supportApp.origin,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: supportApp.redirectUri,
      client_id: supportApp.clientId,
      code_verifier: verifier,
    }),
  });
}

/** Reads the claims of a JWT without verifying it (the API verifies; this only inspects). */
export function claimsOf(jwt: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}
