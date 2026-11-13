import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { startSignIn } from './auth/sign-in';
import type { AppConfig } from './config';

const config: AppConfig = {
  apiUrl: 'https://api.test',
  issuer: 'https://idp.test',
  clientId: 'support-web',
};
const CODE = 'the-authorization-code';
const ACCESS_TOKEN = [{ alg: 'ES256' }, { sub: 'support-agent', scope: 'support:read' }]
  .map((part) => btoa(JSON.stringify(part)).replace(/=+$/, ''))
  .concat('signature')
  .join('.');
const document = {
  documentId: 'doc-1',
  organisationId: 'org-supplier',
  documentType: 'Invoice',
  direction: 'sales',
  status: 'Completed',
  attempts: 1,
  receivedAt: '2026-11-13T11:59:00.000Z',
  updatedAt: '2026-11-13T11:59:05.000Z',
};
const unauthenticated = () =>
  new Response(JSON.stringify({ title: 'Unauthenticated', status: 401, code: 'UNAUTHENTICATED' }), {
    status: 401,
    headers: { 'content-type': 'application/problem+json' },
  });

let server: ReturnType<typeof vi.fn<typeof fetch>>;
let expiresIn: number;
let documents: () => Response;
const calls = (path: string) =>
  server.mock.calls.filter(([url]) => new URL(String(url)).pathname === path);

/** A sign-in started in this tab, and the IdP's redirect back with a code (RFC 9207 `iss`). */
async function returnFromIdp(overrides: Record<string, string> = {}): Promise<void> {
  let target = '';
  await startSignIn(config, (url) => (target = url));
  const state = new URL(target).searchParams.get('state') ?? '';
  const params = new URLSearchParams({ code: CODE, state, iss: config.issuer, ...overrides });
  window.history.replaceState(null, '', `/callback?${params.toString()}`);
}

const consoleCalls = () =>
  (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method));

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  expiresIn = 900;
  documents = () => Response.json({ items: [document] });
  server = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.href === 'https://idp.test/token') {
      return Response.json({
        access_token: ACCESS_TOKEN,
        token_type: 'Bearer',
        expires_in: expiresIn,
      });
    }
    if (url.origin === config.apiUrl && url.pathname === '/support/documents') return documents();
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal('fetch', server);
});

afterEach(() => {
  expect(window.location.search).toBe('');
});

describe('the support app', () => {
  it('says that a reload means signing in again', () => {
    render(<App config={config} />);

    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(screen.getByText(/reload/i)).toBeTruthy();
  });

  it('signs in on /callback and keeps the token in memory only', async () => {
    const consoles = consoleCalls();
    await returnFromIdp();

    render(<App config={config} />);

    expect(await screen.findByText('doc-1')).toBeTruthy();
    expect(screen.getByText(/support-agent/)).toBeTruthy();
    const [, init] = calls('/support/documents')[0]!;
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);
    // Not in web storage, not in a cookie, not in the URL, not in the console.
    expect(sessionStorage).toHaveLength(0);
    expect(localStorage).toHaveLength(0);
    expect(window.document.cookie).toBe('');
    expect(window.location.href).not.toContain(ACCESS_TOKEN);
    for (const spy of consoles) {
      const printed = JSON.stringify(spy.mock.calls);
      expect(printed).not.toContain(ACCESS_TOKEN);
      expect(printed).not.toContain(CODE);
    }
  });

  it('shows why a callback was refused, without calling /token', async () => {
    await returnFromIdp({ state: 'forged' });

    render(<App config={config} />);

    expect(await screen.findByText(/state/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(calls('/token')).toHaveLength(0);
  });

  it('goes back to sign in on a 401', async () => {
    documents = unauthenticated;
    await returnFromIdp();

    render(<App config={config} />);

    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(screen.getByText(/sign in again/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  });

  it('goes back to sign in once the token has expired, without calling the API', async () => {
    expiresIn = 0;
    await returnFromIdp();

    render(<App config={config} />);

    expect(await screen.findByText(/expired/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(calls('/support/documents')).toHaveLength(0);
  });

  it('signs out: the token is dropped and the documents are gone', async () => {
    await returnFromIdp();
    render(<App config={config} />);
    await screen.findByText('doc-1');

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(screen.queryByText('doc-1')).toBeNull();
    expect(sessionStorage).toHaveLength(0);
  });
});
