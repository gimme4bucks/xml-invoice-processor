import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

/** One OAuth client: its secret and the claims its tokens carry. */
export interface ClientConfig {
  secret: string;
  org_id: string;
  peppol_id: string;
  scopes: string[];
}

/** The public client of the support app: Authorization Code + PKCE, so no secret (ADR 0017). */
export const SUPPORT_CLIENT_ID = 'support-web';
export const SUPPORT_SCOPE = 'support:read';

export interface SupportClientConfig {
  /** Exact-match allow-list (RFC 9700 §2.1): no prefixes, no wildcards, no extra query. */
  redirectUris: string[];
  /** Demo support employees: username -> password. */
  users: Record<string, { password: string }>;
}

export interface IdpOptions {
  issuer: string;
  audience: string;
  clients: Record<string, ClientConfig>;
  /** The `support-web` client; without it, only the client-credentials grant exists. */
  support?: SupportClientConfig;
  /** Browser origins (exact) that may call /token, such as the API's Swagger UI. */
  corsOrigins?: string[];
  tokenTtlSeconds?: number;
  /** How long an authorization code can be redeemed: 60 s by default. */
  codeTtlSeconds?: number;
  /** Milliseconds since the epoch; tests move it to expire codes without waiting. */
  now?: () => number;
}

const MAX_FORM_BYTES = 10 * 1024;
/** RFC 7636 §4.1 and §4.2: a verifier of 43-128 unreserved characters; S256 gives 43 base64url. */
const CODE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

/** Parses and checks MOCK_IDP_CLIENTS; throws with a readable message on bad input. */
export function parseClients(json: string | undefined): Record<string, ClientConfig> {
  if (!json) throw new Error('MOCK_IDP_CLIENTS is required (see .env.example)');
  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object') throw new Error('MOCK_IDP_CLIENTS must be an object');
  for (const [id, client] of Object.entries(parsed as Record<string, Partial<ClientConfig>>)) {
    const valid =
      typeof client.secret === 'string' &&
      client.secret.length > 0 &&
      typeof client.org_id === 'string' &&
      typeof client.peppol_id === 'string' &&
      Array.isArray(client.scopes) &&
      client.scopes.every((scope) => typeof scope === 'string');
    if (!valid)
      throw new Error(`MOCK_IDP_CLIENTS: client "${id}" needs secret, org_id, peppol_id, scopes`);
  }
  return parsed as Record<string, ClientConfig>;
}

/**
 * Parses MOCK_IDP_CORS_ORIGINS (comma-separated): browser origins exactly as sent in `Origin`, no
 * path, no wildcard. Throws with a readable message on bad input.
 */
export function parseCorsOrigins(value: string | undefined): string[] {
  const origins = (value ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  for (const origin of origins) {
    if (!isOrigin(origin)) {
      throw new Error(
        `MOCK_IDP_CORS_ORIGINS: "${origin}" is not an origin like https://host[:port]`,
      );
    }
  }
  return origins;
}

function isOrigin(value: string): boolean {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

/**
 * Parses MOCK_IDP_SUPPORT_REDIRECT_URIS (comma-separated) and MOCK_IDP_SUPPORT_USERS (JSON);
 * neither set means no support client. Throws with a readable message on bad input.
 */
export function parseSupportClient(
  redirectUris: string | undefined,
  users: string | undefined,
): SupportClientConfig | undefined {
  if (!redirectUris && !users) return undefined;
  if (!users) throw new Error('MOCK_IDP_SUPPORT_USERS is required for the support client');
  const uris = (redirectUris ?? '')
    .split(',')
    .map((uri) => uri.trim())
    .filter(Boolean);
  if (uris.length === 0 || !uris.every(isRedirectUri)) {
    throw new Error(
      'MOCK_IDP_SUPPORT_REDIRECT_URIS needs absolute http(s) URLs without a fragment, comma-separated',
    );
  }
  const parsed: unknown = JSON.parse(users);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('MOCK_IDP_SUPPORT_USERS must be an object');
  }
  for (const [name, user] of Object.entries(parsed as Record<string, { password?: unknown }>)) {
    if (typeof user?.password !== 'string' || user.password.length === 0) {
      throw new Error(`MOCK_IDP_SUPPORT_USERS: user "${name}" needs a password`);
    }
  }
  return { redirectUris: uris, users: parsed as SupportClientConfig['users'] };
}

function isRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !value.includes('#');
  } catch {
    return false;
  }
}

/** An authorization code, bound to everything the token request has to repeat (RFC 9700 §4.5). */
interface IssuedCode {
  redirectUri: string;
  codeChallenge: string;
  subject: string;
  scope: string;
  expiresAt: number;
}

/** A checked authorization request: the client and the redirect URI are known to be ours. */
interface AuthorizationRequest {
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scope: string;
}

type AuthorizationCheck =
  | { request: AuthorizationRequest }
  /** Never redirect: the client or the redirect URI is unknown (RFC 6749 §4.1.2.1). */
  | { errorPage: string }
  /** An error the registered redirect URI may receive. */
  | { redirect: URL };

/**
 * A minimal OAuth2 issuer for dev, demo and e2e. Signs ES256 JWTs with a key pair generated at
 * startup and publishes the public key as a JWKS. Two grants:
 * - client credentials (RFC 6749 §4.4) for the organisations' systems;
 * - Authorization Code with PKCE (RFC 6749 §4.1, RFC 7636, RFC 9700) for the public client
 *   `support-web`, the browser app of support employees, who sign in on a login form here.
 */
export async function createIdp(options: IdpOptions): Promise<Server> {
  const ttl = options.tokenTtlSeconds ?? 15 * 60;
  const codeTtlMs = (options.codeTtlSeconds ?? 60) * 1000;
  const now = options.now ?? Date.now;
  const support = options.support;
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const kid = randomUUID();
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' }] };
  const codes = new Map<string, IssuedCode>();
  // Browsers call /token only from the support app (the origin it is redirected to) and from the
  // configured origins, such as the API's Swagger UI (ADR 0019); from nowhere else.
  const corsOrigins = new Set([
    ...(support?.redirectUris.map((uri) => new URL(uri).origin) ?? []),
    ...(options.corsOrigins ?? []),
  ]);

  const signToken = (claims: Record<string, string>, subject: string) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'ES256', kid, typ: 'at+jwt' })
      .setIssuer(options.issuer)
      .setAudience(options.audience)
      .setSubject(subject)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime(`${ttl}s`)
      .sign(privateKey);

  function sendToken(res: ServerResponse, accessToken: string, scope: string): void {
    res.setHeader('Cache-Control', 'no-store');
    json(res, 200, { access_token: accessToken, token_type: 'Bearer', expires_in: ttl, scope });
  }

  async function issueToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isForm(req)) {
      return oauthError(res, 400, 'invalid_request', 'Use application/x-www-form-urlencoded');
    }
    const form = new URLSearchParams(await readBody(req));
    const grant = form.get('grant_type');
    if (grant === 'client_credentials') return clientCredentials(req, res, form);
    if (grant === 'authorization_code') return authorizationCode(res, form);
    return oauthError(
      res,
      400,
      'unsupported_grant_type',
      'Only client_credentials and authorization_code',
    );
  }

  async function clientCredentials(
    req: IncomingMessage,
    res: ServerResponse,
    form: URLSearchParams,
  ): Promise<void> {
    const [clientId, secret] = basicCredentials(req) ?? [
      form.get('client_id'),
      form.get('client_secret'),
    ];
    const client = clientId ? options.clients[clientId] : undefined;
    if (!clientId || !client || !secret || !sameSecret(secret, client.secret)) {
      res.setHeader('WWW-Authenticate', 'Basic realm="mock-idp"');
      return oauthError(res, 401, 'invalid_client', 'Unknown client or wrong secret');
    }
    // No scope, or an empty one (Swagger UI with nothing ticked): the client's scopes (RFC 6749 §3.3).
    const asked = form.get('scope')?.split(' ').filter(Boolean) ?? [];
    const requested = asked.length > 0 ? asked : client.scopes;
    if (!requested.every((scope) => client.scopes.includes(scope))) {
      return oauthError(res, 400, 'invalid_scope', 'Scope not granted to this client');
    }

    const scope = requested.join(' ');
    const accessToken = await signToken(
      { org_id: client.org_id, peppol_id: client.peppol_id, scope },
      clientId,
    );
    console.log(JSON.stringify({ msg: 'token issued', clientId, scope }));
    sendToken(res, accessToken, scope);
  }

  /**
   * Redeems a code for a support token. Every attempt burns the code, so a wrong verifier cannot
   * be retried. The token names the employee (`sub`) and carries no organisation.
   */
  async function authorizationCode(res: ServerResponse, form: URLSearchParams): Promise<void> {
    const code = form.get('code') ?? '';
    const issued = codes.get(code);
    codes.delete(code);
    if (!support || form.get('client_id') !== SUPPORT_CLIENT_ID) {
      return oauthError(
        res,
        400,
        'unauthorized_client',
        `Only ${SUPPORT_CLIENT_ID} uses this grant`,
      );
    }
    const verifier = form.get('code_verifier') ?? '';
    if (
      !issued ||
      now() >= issued.expiresAt ||
      form.get('redirect_uri') !== issued.redirectUri ||
      !CODE_VERIFIER.test(verifier) ||
      !sameSecret(s256(verifier), issued.codeChallenge)
    ) {
      return oauthError(res, 400, 'invalid_grant', 'Unknown, used, expired or mismatched code');
    }
    const accessToken = await signToken({ scope: issued.scope }, issued.subject);
    console.log(
      JSON.stringify({
        msg: 'token issued',
        clientId: SUPPORT_CLIENT_ID,
        sub: issued.subject,
        scope: issued.scope,
      }),
    );
    sendToken(res, accessToken, issued.scope);
  }

  /** Checks the client and the redirect URI first: only then may an error be redirected. */
  function checkAuthorization(params: URLSearchParams): AuthorizationCheck {
    const redirectUri = params.get('redirect_uri') ?? '';
    if (!support || params.get('client_id') !== SUPPORT_CLIENT_ID) {
      return { errorPage: 'Unknown client.' };
    }
    if (!support.redirectUris.includes(redirectUri)) {
      return { errorPage: 'This redirect URI is not registered for the client.' };
    }
    const state = params.get('state');
    const fail = (error: string, description: string) => ({
      redirect: authorizationResponse(redirectUri, {
        error,
        error_description: description,
        ...(state ? { state } : {}),
      }),
    });
    if (params.get('response_type') !== 'code') {
      return fail('unsupported_response_type', 'Only response_type=code');
    }
    if (!state) return fail('invalid_request', 'state is required');
    const codeChallenge = params.get('code_challenge') ?? '';
    if (params.get('code_challenge_method') !== 'S256' || !S256_CHALLENGE.test(codeChallenge)) {
      return fail(
        'invalid_request',
        'A code_challenge with code_challenge_method=S256 is required',
      );
    }
    const scopes = (params.get('scope') ?? SUPPORT_SCOPE).split(' ').filter(Boolean);
    if (!scopes.every((scope) => scope === SUPPORT_SCOPE)) {
      return fail('invalid_scope', `Only ${SUPPORT_SCOPE}`);
    }
    return { request: { redirectUri, state, codeChallenge, scope: SUPPORT_SCOPE } };
  }

  /** The redirect back to the client, with `iss` against mix-up attacks (RFC 9207). */
  function authorizationResponse(redirectUri: string, params: Record<string, string>): URL {
    const url = new URL(redirectUri);
    for (const [name, value] of Object.entries({ ...params, iss: options.issuer })) {
      url.searchParams.set(name, value);
    }
    return url;
  }

  /** GET shows the login form; POST checks the credentials and redirects with a code. */
  async function authorize(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const login = req.method === 'POST';
    if (login && !isForm(req)) return htmlPage(res, 400, errorPage('Send the login form.'));
    const params = login
      ? new URLSearchParams(await readBody(req))
      : new URL(req.url ?? '/', 'http://idp').searchParams;
    const check = checkAuthorization(params);
    if ('errorPage' in check) return htmlPage(res, 400, errorPage(check.errorPage));
    if ('redirect' in check) return redirect(res, check.redirect);
    const { request } = check;
    if (!login) return htmlPage(res, 200, loginPage(request), request.redirectUri);

    const username = params.get('username') ?? '';
    // Own properties only: "constructor" or "__proto__" is not a user.
    const user =
      support && Object.hasOwn(support.users, username) ? support.users[username] : undefined;
    if (!user || !sameSecret(params.get('password') ?? '', user.password)) {
      const page = loginPage(request, 'Invalid username or password.');
      return htmlPage(res, 401, page, request.redirectUri);
    }
    const code = randomBytes(32).toString('base64url');
    for (const [key, issued] of codes) if (now() >= issued.expiresAt) codes.delete(key);
    codes.set(code, {
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      subject: username,
      scope: request.scope,
      expiresAt: now() + codeTtlMs,
    });
    redirect(res, authorizationResponse(request.redirectUri, { code, state: request.state }));
  }

  /**
   * CORS for the allowed origins only; no credentials, because there are no cookies. Swagger UI
   * sends the client in a Basic header and adds X-Requested-With.
   */
  function tokenCors(req: IncomingMessage, res: ServerResponse): void {
    res.setHeader('Vary', 'Origin');
    const origin = req.headers.origin;
    if (!origin || !corsOrigins.has(origin)) return;
    res.setHeader('Access-Control-Allow-Origin', origin);
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'POST');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type, X-Requested-With',
      );
      res.setHeader('Access-Control-Max-Age', '600');
    }
  }

  return createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://idp').pathname;
    if (req.method === 'GET' && path === '/.well-known/jwks.json') {
      res.setHeader('Cache-Control', 'public, max-age=300');
      return json(res, 200, jwks);
    }
    if (path === '/token' && (req.method === 'POST' || req.method === 'OPTIONS')) {
      tokenCors(req, res);
      if (req.method === 'OPTIONS') return void res.writeHead(204).end();
      issueToken(req, res).catch(() => oauthError(res, 400, 'invalid_request', 'Bad request'));
      return;
    }
    if (path === '/authorize' && (req.method === 'GET' || req.method === 'POST')) {
      authorize(req, res).catch(() => htmlPage(res, 400, errorPage('Bad request.')));
      return;
    }
    json(res, 404, { error: 'not_found' });
  });
}

const isForm = (req: IncomingMessage) =>
  req.headers['content-type']?.startsWith('application/x-www-form-urlencoded') ?? false;

function basicCredentials(req: IncomingMessage): [string, string] | undefined {
  const match = /^Basic (.+)$/i.exec(req.headers.authorization ?? '');
  if (!match?.[1]) return undefined;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 0) return undefined;
  // RFC 6749 §2.3.1: both parts are form-urlencoded before base64.
  return [
    decodeURIComponent(decoded.slice(0, colon)),
    decodeURIComponent(decoded.slice(colon + 1)),
  ];
}

const digest = (value: string) => createHash('sha256').update(value).digest();
const sameSecret = (given: string, expected: string) =>
  timingSafeEqual(digest(given), digest(expected));
/** The S256 code challenge of a verifier (RFC 7636 §4.2). */
const s256 = (verifier: string) => digest(verifier).toString('base64url');

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_FORM_BYTES) throw new Error('Form too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

function oauthError(res: ServerResponse, status: number, error: string, description: string) {
  json(res, status, { error, error_description: description });
}

function redirect(res: ServerResponse, location: URL): void {
  // 303, so the browser follows with a GET and never re-posts the password (RFC 9700 §4.12).
  res.writeHead(303, { Location: location.href, 'Cache-Control': 'no-store' }).end();
}

/**
 * A server-rendered page: never cached, never framed (clickjacking), no scripts. The login form
 * may only post here, and the redirect after it may only go to the client's registered origin.
 */
function htmlPage(res: ServerResponse, status: number, html: string, redirectUri?: string): void {
  const formAction = redirectUri ? `'self' ${new URL(redirectUri).origin}` : "'none'";
  res
    .writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': `default-src 'none'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    })
    .end(html);
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );

const page = (title: string, body: string) =>
  `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${title}</title></head>
<body>
<h1>${title}</h1>
<p>Mock identity provider: for development and demos only.</p>
${body}
</body>
</html>
`;

function errorPage(message: string): string {
  return page('Sign-in error', `<p role="alert">${escapeHtml(message)}</p>`);
}

/** The login form; the checked request travels in hidden fields to POST /authorize. */
function loginPage(request: AuthorizationRequest, message?: string): string {
  const hidden = {
    response_type: 'code',
    client_id: SUPPORT_CLIENT_ID,
    redirect_uri: request.redirectUri,
    state: request.state,
    code_challenge: request.codeChallenge,
    code_challenge_method: 'S256',
    scope: request.scope,
  };
  return page(
    'Support sign-in',
    `${message ? `<p role="alert">${escapeHtml(message)}</p>\n` : ''}<form method="post" action="/authorize">
${Object.entries(hidden)
  .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`)
  .join('\n')}
<p><label>Username <input name="username" autocomplete="username" required></label></p>
<p><label>Password <input name="password" type="password" autocomplete="current-password" required></label></p>
<p><button type="submit">Sign in</button></p>
</form>`,
  );
}
