import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config';
import { codeChallenge } from './pkce';
import { completeSignIn, SignInError, startSignIn } from './sign-in';

const config: AppConfig = {
  apiUrl: 'https://api.test',
  issuer: 'https://idp.test',
  clientId: 'support-web',
};
const NOW = Date.parse('2026-11-13T12:00:00Z');
const CODE = 'the-authorization-code';

/** A JWT as the IdP issues it; only the payload matters here (the API verifies the signature). */
const jwt = (claims: object) =>
  ['{"alg":"ES256"}', JSON.stringify(claims)]
    .map((part) => btoa(part).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'))
    .concat('signature')
    .join('.');
const ACCESS_TOKEN = jwt({ sub: 'support-agent', scope: 'support:read' });

/** Starts a sign-in like the app does and returns the state it sent to the IdP. */
async function signInStarted(): Promise<{ state: string; authorize: URL }> {
  let target = '';
  await startSignIn(config, (url) => (target = url));
  const authorize = new URL(target);
  return { state: authorize.searchParams.get('state') ?? '', authorize };
}

/** The IdP's redirect back to the app (RFC 6749 §4.1.2, plus `iss` from RFC 9207). */
function returnFromIdp(params: Record<string, string>): void {
  window.history.replaceState(null, '', `/callback?${new URLSearchParams(params).toString()}`);
}

let tokenEndpoint: ReturnType<typeof vi.fn>;

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  tokenEndpoint = vi.fn(async () =>
    Response.json({ access_token: ACCESS_TOKEN, token_type: 'Bearer', expires_in: 900 }),
  );
  vi.stubGlobal('fetch', tokenEndpoint);
});

afterEach(() => {
  expect(window.location.search, 'the code stays out of the address bar').toBe('');
});

describe('starting the sign-in', () => {
  it('sends the browser to /authorize with S256, a state and the callback URI', async () => {
    const { state, authorize } = await signInStarted();

    expect(`${authorize.origin}${authorize.pathname}`).toBe('https://idp.test/authorize');
    const params = Object.fromEntries(authorize.searchParams);
    expect(params).toMatchObject({
      response_type: 'code',
      client_id: 'support-web',
      redirect_uri: `${window.location.origin}/callback`,
      scope: 'support:read',
      code_challenge_method: 'S256',
    });
    expect(state).toMatch(/^[A-Za-z0-9\-_]{22,}$/);
    expect(params.code_challenge).toMatch(/^[A-Za-z0-9\-_]{43}$/);
  });

  it('keeps the verifier and the state in sessionStorage only, for the redirect', async () => {
    const { state, authorize } = await signInStarted();

    const stored = Object.values({ ...sessionStorage }).join(' ');
    expect(stored).toContain(state);
    const verifier = /[A-Za-z0-9\-_]{43}/.exec(stored.replace(state, ''))?.[0] ?? '';
    expect(await codeChallenge(verifier)).toBe(authorize.searchParams.get('code_challenge'));
    expect(localStorage).toHaveLength(0);
    expect(document.cookie).toBe('');
  });
});

describe('the callback', () => {
  it('exchanges the code with the verifier, then clears the URL and the stored verifier', async () => {
    const { state, authorize } = await signInStarted();
    returnFromIdp({ code: CODE, state, iss: config.issuer });

    const session = await completeSignIn(config);

    expect(session).toEqual({
      accessToken: ACCESS_TOKEN,
      expiresAt: NOW + 900_000,
      subject: 'support-agent',
    });
    expect(tokenEndpoint).toHaveBeenCalledOnce();
    const [url, init] = tokenEndpoint.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://idp.test/token');
    expect(init.method).toBe('POST');
    const form = new URLSearchParams(init.body as URLSearchParams);
    expect(Object.fromEntries(form)).toMatchObject({
      grant_type: 'authorization_code',
      code: CODE,
      redirect_uri: `${window.location.origin}/callback`,
      client_id: 'support-web',
    });
    expect(await codeChallenge(form.get('code_verifier') ?? '')).toBe(
      authorize.searchParams.get('code_challenge'),
    );
    expect(window.location.pathname).toBe('/');
    expect(sessionStorage).toHaveLength(0);
  });

  it.each([
    [
      'a mismatched state',
      (state: string) => ({ code: CODE, state: `${state}x`, iss: config.issuer }),
      /state/,
    ],
    ['a missing state', () => ({ code: CODE, iss: config.issuer }), /state/],
    [
      'another issuer (mix-up, RFC 9207)',
      (state: string) => ({ code: CODE, state, iss: 'https://evil.test' }),
      /issuer/,
    ],
    ['a missing issuer', (state: string) => ({ code: CODE, state }), /issuer/],
    [
      'an error from the IdP',
      (state: string) => ({ error: 'access_denied', state, iss: config.issuer }),
      /access_denied/,
    ],
  ])('rejects %s without calling /token', async (_case, callback, message) => {
    const { state } = await signInStarted();
    returnFromIdp(callback(state));

    const failure = await completeSignIn(config).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SignInError);
    expect((failure as Error).message).toMatch(message);
    expect((failure as Error).message).not.toContain(CODE);
    expect(tokenEndpoint).not.toHaveBeenCalled();
    expect(sessionStorage, 'the stored verifier is used once').toHaveLength(0);
  });

  it('rejects a callback that this tab did not start', async () => {
    returnFromIdp({ code: CODE, state: 'guessed', iss: config.issuer });

    await expect(completeSignIn(config)).rejects.toThrow(SignInError);
    expect(tokenEndpoint).not.toHaveBeenCalled();
  });

  it('rejects a code that /token refuses', async () => {
    const { state } = await signInStarted();
    returnFromIdp({ code: CODE, state, iss: config.issuer });
    tokenEndpoint.mockResolvedValueOnce(Response.json({ error: 'invalid_grant' }, { status: 400 }));

    await expect(completeSignIn(config)).rejects.toThrow(/invalid_grant/);
  });
});
