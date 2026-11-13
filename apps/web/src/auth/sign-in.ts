import type { AppConfig } from '../config';
import { codeChallenge, createCodeVerifier, createState } from './pkce';

// Authorization Code + PKCE for the public client (RFC 6749 §4.1, RFC 7636, RFC 9207, RFC 9700),
// the browser side of ADR 0017. The verifier and the state wait in sessionStorage for the one
// redirect to the IdP and back, and are removed as soon as the callback reads them. The access
// token never touches storage: the caller keeps the Session in memory (ADR 0018).

/** A signed-in support employee. Lives in memory only (ADR 0018). */
export interface Session {
  accessToken: string;
  /** Epoch milliseconds after which the API refuses the token. */
  expiresAt: number;
  /** The employee (`sub`), for display only. */
  subject?: string;
}

/** The sign-in could not be completed; the message is safe to show (no code, no token). */
export class SignInError extends Error {
  override readonly name = 'SignInError';
}

export const CALLBACK_PATH = '/callback';
const SCOPE = 'support:read';
/** sessionStorage: per tab, gone when the tab closes; holds nothing once the callback ran. */
const PENDING_KEY = 'xip.sign-in';

interface PendingSignIn {
  verifier: string;
  state: string;
}

/** The registered redirect URI: this app's own origin. */
const redirectUri = () => `${window.location.origin}${CALLBACK_PATH}`;

/** Sends the browser to the IdP's login, remembering the verifier and the state for the callback. */
export async function startSignIn(
  config: AppConfig,
  navigate: (url: string) => void = (url) => window.location.assign(url),
): Promise<void> {
  const pending: PendingSignIn = { verifier: createCodeVerifier(), state: createState() };
  const authorize = new URL(`${config.issuer}/authorize`);
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: redirectUri(),
    scope: SCOPE,
    state: pending.state,
    code_challenge: await codeChallenge(pending.verifier),
    code_challenge_method: 'S256',
  }).toString();
  sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  navigate(authorize.href);
}

/**
 * Completes the sign-in on /callback. The code leaves the address bar (and the history entry)
 * first, and the stored verifier is used once, whatever happens next. A missing or different
 * `state` or `iss` is refused before the code goes anywhere.
 */
export async function completeSignIn(config: AppConfig): Promise<Session> {
  const params = new URLSearchParams(window.location.search);
  window.history.replaceState(null, '', '/');
  const pending = takePendingSignIn();

  if (!pending || params.get('state') !== pending.state) {
    throw new SignInError('The sign-in response does not match a sign-in from this tab (state).');
  }
  if (params.get('iss') !== config.issuer) {
    throw new SignInError('The sign-in response comes from another issuer.');
  }
  const error = params.get('error');
  if (error) throw new SignInError(`The identity provider refused the sign-in (${error}).`);
  const code = params.get('code');
  if (!code) throw new SignInError('The sign-in response has no authorization code.');

  return redeem(config, code, pending.verifier);
}

function takePendingSignIn(): PendingSignIn | undefined {
  const stored = sessionStorage.getItem(PENDING_KEY);
  sessionStorage.removeItem(PENDING_KEY);
  try {
    const pending = JSON.parse(stored ?? 'null') as Partial<PendingSignIn> | null;
    return typeof pending?.verifier === 'string' && typeof pending.state === 'string'
      ? { verifier: pending.verifier, state: pending.state }
      : undefined;
  } catch {
    return undefined;
  }
}

/** POST /token with the verifier and no secret: only this tab, which made the verifier, can redeem. */
async function redeem(config: AppConfig, code: string, verifier: string): Promise<Session> {
  const response = await fetch(`${config.issuer}/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
      client_id: config.clientId,
      code_verifier: verifier,
    }),
  }).catch(() => {
    throw new SignInError(
      'Could not reach the identity provider. Does this browser trust the local CA?',
    );
  });
  const body = (await response.json().catch(() => ({}))) as {
    access_token?: unknown;
    expires_in?: unknown;
    error?: unknown;
  };
  if (!response.ok || typeof body.access_token !== 'string') {
    const error = typeof body.error === 'string' ? body.error : `HTTP ${response.status}`;
    throw new SignInError(`The identity provider refused the code (${error}).`);
  }
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 0;
  return {
    accessToken: body.access_token,
    expiresAt: Date.now() + expiresIn * 1000,
    ...subjectOf(body.access_token),
  };
}

/** The `sub` claim, read without verifying (the API verifies); only to show who is signed in. */
function subjectOf(jwt: string): { subject?: string } {
  try {
    const payload = (jwt.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(payload)) as { sub?: unknown };
    return typeof claims.sub === 'string' ? { subject: claims.sub } : {};
  } catch {
    return {};
  }
}
