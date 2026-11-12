import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

/** One OAuth client: its secret and the claims its tokens carry. */
export interface ClientConfig {
  secret: string;
  org_id: string;
  peppol_id: string;
  scopes: string[];
}

export interface IdpOptions {
  issuer: string;
  audience: string;
  clients: Record<string, ClientConfig>;
  tokenTtlSeconds?: number;
}

const MAX_FORM_BYTES = 10 * 1024;

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
 * A minimal OAuth2 client-credentials issuer (RFC 6749 §4.4) for dev, demo and e2e. Signs ES256
 * JWTs with a key pair generated at startup and publishes the public key as a JWKS.
 */
export async function createIdp(options: IdpOptions): Promise<Server> {
  const ttl = options.tokenTtlSeconds ?? 15 * 60;
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const kid = randomUUID();
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' }] };

  async function issueToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) {
      return oauthError(res, 400, 'invalid_request', 'Use application/x-www-form-urlencoded');
    }
    const form = new URLSearchParams(await readBody(req));
    if (form.get('grant_type') !== 'client_credentials') {
      return oauthError(res, 400, 'unsupported_grant_type', 'Only client_credentials');
    }
    const [clientId, secret] = basicCredentials(req) ?? [
      form.get('client_id'),
      form.get('client_secret'),
    ];
    const client = clientId ? options.clients[clientId] : undefined;
    if (!clientId || !client || !secret || !sameSecret(secret, client.secret)) {
      res.setHeader('WWW-Authenticate', 'Basic realm="mock-idp"');
      return oauthError(res, 401, 'invalid_client', 'Unknown client or wrong secret');
    }
    const requested = form.get('scope')?.split(' ').filter(Boolean) ?? client.scopes;
    if (!requested.every((scope) => client.scopes.includes(scope))) {
      return oauthError(res, 400, 'invalid_scope', 'Scope not granted to this client');
    }

    const scope = requested.join(' ');
    const accessToken = await new SignJWT({
      org_id: client.org_id,
      peppol_id: client.peppol_id,
      scope,
    })
      .setProtectedHeader({ alg: 'ES256', kid, typ: 'at+jwt' })
      .setIssuer(options.issuer)
      .setAudience(options.audience)
      .setSubject(clientId)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime(`${ttl}s`)
      .sign(privateKey);
    console.log(JSON.stringify({ msg: 'token issued', clientId, scope }));
    res.setHeader('Cache-Control', 'no-store');
    json(res, 200, { access_token: accessToken, token_type: 'Bearer', expires_in: ttl, scope });
  }

  return createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://idp').pathname;
    if (req.method === 'GET' && path === '/.well-known/jwks.json') {
      res.setHeader('Cache-Control', 'public, max-age=300');
      return json(res, 200, jwks);
    }
    if (req.method === 'POST' && path === '/token') {
      issueToken(req, res).catch(() => oauthError(res, 400, 'invalid_request', 'Bad request'));
      return;
    }
    json(res, 404, { error: 'not_found' });
  });
}

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
