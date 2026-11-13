import { readFileSync } from 'node:fs';
import { type IncomingHttpHeaders, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTPayload,
  SignJWT,
  type CryptoKey,
} from 'jose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInMemoryAdapters, inMemoryProviders } from '../../src/app/adapters';
import { ApiModule, type ApiOptions } from '../../src/app/modules';
import type { AuthOptions } from '../../src/shared/auth/auth-options';
import { MAX_DOCUMENT_BYTES } from '../../src/documents/adapters/inbound/http/xml-body';
import { configureHttpApp, httpAppOptions } from '../../src/shared/http/http-app';
import { peppolFixture } from '../fixtures/peppol';

/**
 * The HTTP API through supertest: ApiModule with the in-memory adapters, the real guards, filter,
 * logger and OpenAPI, and tokens signed against a local JWKS (no IdP needed).
 */
const fixture = readFileSync(join(__dirname, '../fixtures/invoice-minimal.xml'));
const ISSUER = 'https://idp.test';
const AUDIENCE = 'xml-invoice-processor';

/** Supplier (0106:11111111) and customer (0106:22222222) of the fixture, and an outsider. */
const supplier = { org_id: 'org-supplier', peppol_id: '0106:11111111' };
const customer = { org_id: 'org-customer', peppol_id: '0106:22222222' };
const outsider = { org_id: 'org-outsider', peppol_id: '0106:99999999' };
const ALL_SCOPES = 'documents:submit documents:read';

let signingKey: CryptoKey;
let foreignKey: CryptoKey;
let auth: AuthOptions;

beforeAll(async () => {
  const pair = await generateKeyPair('ES256');
  signingKey = pair.privateKey;
  foreignKey = (await generateKeyPair('ES256')).privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'ES256' };
  auth = { issuer: ISSUER, audience: AUDIENCE, keys: createLocalJWKSet({ keys: [jwk] }) };
});

interface TokenOptions {
  claims?: JWTPayload;
  key?: CryptoKey;
  issuer?: string;
  audience?: string;
  expiresAt?: number | string;
}

function token(org = supplier, scope = ALL_SCOPES, options: TokenOptions = {}): Promise<string> {
  return new SignJWT({ ...org, scope, ...options.claims })
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setSubject('client-1')
    .setIssuedAt()
    .setExpirationTime(options.expiresAt ?? '5m')
    .sign(options.key ?? signingKey);
}

async function startApi(options: Omit<ApiOptions, 'auth'> = {}): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ApiModule.register(inMemoryProviders(createInMemoryAdapters()), {
        auth,
        logging: { level: 'silent' },
        ...options,
      }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication(httpAppOptions);
  configureHttpApp(app);
  await app.listen(0, '127.0.0.1');
  return app;
}

let keySequence = 0;
const newKey = () => `key-${++keySequence}`;
/** A distinct invoice per call, so the content hash never collides by accident. */
const invoice = (number: string) =>
  Buffer.from(fixture.toString().replace('INV-2026-0042', number));

const PROBLEM_JSON = /^application\/problem\+json/;

/**
 * A bare POST that reads the response even when the server answers before the upload ends
 * (supertest then fails with EPIPE), optionally without Content-Length (chunked).
 */
function rawPost(
  app: INestApplication,
  headers: Record<string, string>,
  body: Buffer,
  chunked: boolean,
): Promise<{ status: number; headers: IncomingHttpHeaders; body: Record<string, unknown> }> {
  const { port } = (app.getHttpServer() as Server).address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/documents',
        headers: chunked ? headers : { ...headers, 'Content-Length': body.length },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>,
          }),
        );
      },
    );
    req.on('error', reject);
    // Write in pieces so the chunked upload really streams.
    for (let offset = 0; offset < body.length; offset += 64 * 1024) {
      req.write(body.subarray(offset, offset + 64 * 1024));
    }
    req.end();
  });
}

describe('HTTP API', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer() as Server);

  beforeAll(async () => {
    app = await startApi();
  });

  afterAll(async () => {
    await app.close();
  });

  async function submit(
    xml: Buffer | string,
    {
      bearer,
      key = newKey(),
      contentType = 'application/xml',
    }: { bearer?: string; key?: string | null; contentType?: string } = {},
  ) {
    const req = http()
      .post('/documents')
      .set('Authorization', `Bearer ${bearer ?? (await token())}`)
      .set('Content-Type', contentType);
    if (key !== null) void req.set('Idempotency-Key', key);
    return req.send(xml);
  }

  describe('POST /documents', () => {
    it('accepts an invoice with 202, Location and the document id', async () => {
      const res = await submit(invoice('INV-ACCEPT'));
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ documentId: expect.any(String), status: 'Received' });
      expect(res.headers.location).toBe(`/documents/${res.body.documentId}`);
      expect(res.headers['idempotent-replayed']).toBeUndefined();

      const status = await http()
        .get(res.headers.location!)
        .set('Authorization', `Bearer ${await token()}`);
      expect(status.status).toBe(200);
      expect(status.body).toMatchObject({
        documentId: res.body.documentId,
        documentType: 'Invoice',
        direction: 'sales',
        status: 'Received',
        attempts: 0,
      });
      expect(status.body).not.toHaveProperty('organisationId');
    });

    it('derives the direction from the token: the customer submits a purchase invoice', async () => {
      const bearer = await token(customer);
      const res = await submit(invoice('INV-PURCHASE'), { bearer });
      const status = await http()
        .get(`/documents/${res.body.documentId}`)
        .set('Authorization', `Bearer ${bearer}`);
      expect(status.body.direction).toBe('purchase');
    });

    it('replays a retry with the same key and body: same answer plus Idempotent-Replayed', async () => {
      const xml = invoice('INV-REPLAY');
      const key = newKey();
      const first = await submit(xml, { key });
      const second = await submit(xml, { key });
      expect(second.status).toBe(202);
      expect(second.body).toEqual(first.body);
      expect(second.headers.location).toBe(first.headers.location);
      expect(second.headers['idempotent-replayed']).toBe('true');
    });

    it('409 IDEMPOTENCY_KEY_REUSED for the same key with other content', async () => {
      const key = newKey();
      const first = await submit(invoice('INV-KEY-1'), { key });
      const res = await submit(invoice('INV-KEY-2'), { key });
      expect(res.status).toBe(409);
      expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
      expect(res.body).toMatchObject({
        status: 409,
        code: 'IDEMPOTENCY_KEY_REUSED',
        existingDocumentId: first.body.documentId,
      });
    });

    it('409 DUPLICATE_DOCUMENT for the same file under a new key', async () => {
      const xml = invoice('INV-DUPLICATE');
      const first = await submit(xml);
      const res = await submit(xml);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: 'DUPLICATE_DOCUMENT',
        existingDocumentId: first.body.documentId,
      });
    });

    it('400 INVALID_REQUEST without an Idempotency-Key or with an invalid one', async () => {
      const missing = await submit(invoice('INV-NO-KEY'), { key: null });
      expect(missing.status).toBe(400);
      expect(missing.headers['content-type']).toMatch(PROBLEM_JSON);
      expect(missing.body).toMatchObject({
        type: 'urn:xip:problem:invalid-request',
        title: 'Invalid request',
        status: 400,
        code: 'INVALID_REQUEST',
        errors: [{ in: 'header', name: 'Idempotency-Key', message: 'is required' }],
      });

      const invalid = await submit(invoice('INV-BAD-KEY'), { key: 'has spaces' });
      expect(invalid.status).toBe(400);
      expect((await submit(invoice('INV-LONG'), { key: 'k'.repeat(256) })).status).toBe(400);
    });

    it('413 PAYLOAD_TOO_LARGE above 1 MiB, before reading the body', async () => {
      const headers = {
        Authorization: `Bearer ${await token()}`,
        'Content-Type': 'application/xml',
        'Idempotency-Key': newKey(),
      };
      const tooBig = Buffer.alloc(MAX_DOCUMENT_BYTES + 1, ' ');
      // Declared up front: rejected on Content-Length alone. Chunked: rejected while streaming.
      for (const chunked of [false, true]) {
        const res = await rawPost(app, headers, tooBig, chunked);
        expect(res.status, `chunked=${chunked}`).toBe(413);
        expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
        expect(res.body).toMatchObject({ code: 'PAYLOAD_TOO_LARGE', maxBytes: MAX_DOCUMENT_BYTES });
      }
    });

    it('415 UNSUPPORTED_MEDIA_TYPE for anything but application/xml', async () => {
      for (const contentType of ['text/xml', 'application/json', 'text/plain']) {
        const res = await submit(invoice('INV-MEDIA'), { contentType });
        expect(res.status, contentType).toBe(415);
        expect(res.body.code).toBe('UNSUPPORTED_MEDIA_TYPE');
      }
      const gzip = await http()
        .post('/documents')
        .set('Authorization', `Bearer ${await token()}`)
        .set('Content-Type', 'application/xml')
        .set('Content-Encoding', 'gzip')
        .set('Idempotency-Key', newKey())
        .send(invoice('INV-GZIP'));
      expect(gzip.status).toBe(415);
    });

    it('415 UNSUPPORTED_CHARSET for anything but UTF-8', async () => {
      const charset = await submit(invoice('INV-LATIN1'), {
        contentType: 'application/xml; charset=iso-8859-1',
      });
      expect(charset.status).toBe(415);
      expect(charset.body.code).toBe('UNSUPPORTED_CHARSET');

      const declared = invoice('INV-DECLARED').toString().replace('UTF-8', 'ISO-8859-1');
      expect((await submit(declared)).body.code).toBe('UNSUPPORTED_CHARSET');

      const invalidBytes = Buffer.concat([invoice('INV-BYTES'), Buffer.from([0xff, 0xfe])]);
      expect((await submit(invalidBytes)).body.code).toBe('UNSUPPORTED_CHARSET');

      const ok = await submit(invoice('INV-UTF8'), {
        contentType: 'application/xml; charset="UTF-8"',
      });
      expect(ok.status).toBe(202);
    });

    it('422 DOCUMENT_REJECTED with reason and errors for a DOCTYPE (XXE guard)', async () => {
      const xml = fixture
        .toString()
        .replace(
          '<Invoice',
          '<!DOCTYPE Invoice [<!ENTITY x SYSTEM "file:///etc/passwd">]>\n<Invoice',
        );
      const res = await submit(xml);
      expect(res.status).toBe(422);
      expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
      expect(res.body).toMatchObject({
        code: 'DOCUMENT_REJECTED',
        reason: 'doctype-forbidden',
        errors: [{ message: expect.any(String) }],
      });
    });

    it('accepts a credit note with 202; its documentType is CreditNote', async () => {
      const res = await submit(peppolFixture('credit-note'));
      expect(res.status).toBe(202);

      const status = await http()
        .get(res.headers.location!)
        .set('Authorization', `Bearer ${await token()}`);
      expect(status.body).toMatchObject({ documentType: 'CreditNote', direction: 'sales' });
    });

    it('422 NOT_A_PARTY when the token organisation is neither supplier nor customer', async () => {
      const res = await submit(invoice('INV-OUTSIDER'), { bearer: await token(outsider) });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('NOT_A_PARTY');
    });

    it('500 INTERNAL_ERROR without internals for an unexpected error', async () => {
      // The stub mapper throws a plain Error on an invoice without EndpointIDs.
      const xml = fixture
        .toString()
        .replaceAll(/<cbc:EndpointID[^>]*>[^<]*<\/cbc:EndpointID>/g, '');
      const res = await submit(xml);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        type: 'urn:xip:problem:internal-error',
        title: 'Internal error',
        status: 500,
        detail: 'An unexpected error occurred.',
        code: 'INTERNAL_ERROR',
        correlationId: expect.any(String),
      });
    });
  });

  describe('authentication and authorisation', () => {
    const getList = (authorization?: string) => {
      const req = http().get('/documents');
      return authorization ? req.set('Authorization', authorization) : req;
    };

    it('401 UNAUTHENTICATED with WWW-Authenticate when the token is missing', async () => {
      const res = await getList();
      expect(res.status).toBe(401);
      expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
      expect(res.headers['www-authenticate']).toBe('Bearer');
      expect(res.body.code).toBe('UNAUTHENTICATED');
      expect((await getList('Basic dXNlcjpwYXNz')).status).toBe(401);
    });

    it.each<[string, () => Promise<string>]>([
      [
        'expired',
        () => token(supplier, ALL_SCOPES, { expiresAt: Math.floor(Date.now() / 1000) - 60 }),
      ],
      ['from another issuer', () => token(supplier, ALL_SCOPES, { issuer: 'https://evil.test' })],
      ['for another audience', () => token(supplier, ALL_SCOPES, { audience: 'other-api' })],
      ['signed with an unknown key', () => token(supplier, ALL_SCOPES, { key: foreignKey })],
      ['without org_id', () => token({ peppol_id: supplier.peppol_id } as typeof supplier)],
      ['with a malformed peppol_id', () => token({ ...supplier, peppol_id: 'not-a-peppol-id' })],
      ['not a JWT at all', () => Promise.resolve('not.a.jwt')],
      [
        'with alg HS256 (algorithm allowlist)',
        () =>
          new SignJWT({ ...supplier, scope: ALL_SCOPES })
            .setProtectedHeader({ alg: 'HS256', kid: 'test-key' })
            .setIssuer(ISSUER)
            .setAudience(AUDIENCE)
            .setSubject('client-1')
            .setExpirationTime('5m')
            .sign(new TextEncoder().encode('a-shared-secret-of-at-least-32-bytes!')),
      ],
      [
        'with alg none',
        () => {
          const encode = (part: object) => Buffer.from(JSON.stringify(part)).toString('base64url');
          const claims = { ...supplier, scope: ALL_SCOPES, iss: ISSUER, aud: AUDIENCE, sub: 'c' };
          return Promise.resolve(
            `${encode({ alg: 'none' })}.${encode({ ...claims, exp: 9999999999 })}.`,
          );
        },
      ],
    ])('401 for a token %s', async (_case, makeToken) => {
      const res = await getList(`Bearer ${await makeToken()}`);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('UNAUTHENTICATED');
      expect(res.headers['www-authenticate']).toBe('Bearer error="invalid_token"');
    });

    it('403 INSUFFICIENT_SCOPE when the token lacks the route scope', async () => {
      const readOnly = await submit(invoice('INV-READ-ONLY'), {
        bearer: await token(supplier, 'documents:read'),
      });
      expect(readOnly.status).toBe(403);
      expect(readOnly.headers['content-type']).toMatch(PROBLEM_JSON);
      expect(readOnly.body).toMatchObject({
        code: 'INSUFFICIENT_SCOPE',
        requiredScope: 'documents:submit',
      });
      expect(readOnly.headers['www-authenticate']).toContain('insufficient_scope');

      const submitOnly = await getList(`Bearer ${await token(supplier, 'documents:submit')}`);
      expect(submitOnly.status).toBe(403);
      expect(submitOnly.body.requiredScope).toBe('documents:read');
    });

    it("isolates organisations: another organisation's document is 404 everywhere", async () => {
      const { body } = await submit(invoice('INV-ISOLATION'));
      const other = `Bearer ${await token({ org_id: 'org-other', peppol_id: '0106:11111111' })}`;
      for (const path of ['', '/result', '/history']) {
        const res = await http()
          .get(`/documents/${body.documentId}${path}`)
          .set('Authorization', other);
        expect(res.status, path).toBe(404);
        expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
        expect(res.body.code).toBe('DOCUMENT_NOT_FOUND');
      }
      const list = await getList(other);
      expect(list.status).toBe(200);
      expect(list.body.items).toEqual([]);
    });

    it('keeps /health public', async () => {
      expect((await http().get('/health')).body).toEqual({ status: 'ok' });
    });
  });

  describe('GET /documents', () => {
    const asCustomer = async () => `Bearer ${await token(customer)}`;

    it('pages newest first with an opaque cursor and filters by status', async () => {
      const bearer = await token(customer);
      for (const n of [1, 2, 3]) await submit(invoice(`INV-LIST-${n}`), { bearer });

      const first = await http()
        .get('/documents?limit=2')
        .set('Authorization', await asCustomer());
      expect(first.status).toBe(200);
      expect(first.body.items).toHaveLength(2);
      expect(first.body.nextCursor).toEqual(expect.any(String));
      const next = await http()
        .get('/documents')
        .query({ limit: 2, cursor: first.body.nextCursor })
        .set('Authorization', await asCustomer());
      expect(next.body.items.length).toBeGreaterThan(0);

      const completed = await http()
        .get('/documents?status=Completed')
        .set('Authorization', await asCustomer());
      expect(completed.body).toEqual({ items: [] });
    });

    it('filters by document type', async () => {
      const creditNote = await submit(peppolFixture('credit-note'), {
        bearer: await token(customer),
      });
      expect(creditNote.status).toBe(202);

      const creditNotes = await http()
        .get('/documents?type=CreditNote')
        .set('Authorization', await asCustomer());
      expect(creditNotes.status).toBe(200);
      expect(creditNotes.body.items).toEqual([
        expect.objectContaining({
          documentId: creditNote.body.documentId,
          documentType: 'CreditNote',
        }),
      ]);
      const invoices = await http()
        .get('/documents?type=Invoice&limit=100')
        .set('Authorization', await asCustomer());
      expect(invoices.body.items.length).toBeGreaterThan(0);
      expect(
        invoices.body.items.every(
          (item: { documentType: string }) => item.documentType === 'Invoice',
        ),
      ).toBe(true);
    });

    it.each([
      'limit=0',
      'limit=101',
      'limit=abc',
      'status=Done',
      'type=Order',
      'cursor=%3Cx%3E',
      'org_id=other',
    ])('400 INVALID_REQUEST for ?%s', async (query) => {
      const res = await http()
        .get(`/documents?${query}`)
        .set('Authorization', await asCustomer());
      expect(res.status).toBe(400);
      expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
      expect(res.body.code).toBe('INVALID_REQUEST');
      expect(res.body.errors[0].in).toBe('query');
    });
  });

  describe('GET /documents/{id}, /result and /history', () => {
    it('404 DOCUMENT_NOT_FOUND for an unknown id and 400 for a malformed one', async () => {
      const bearer = `Bearer ${await token()}`;
      const unknown = await http()
        .get('/documents/00000000-0000-4000-8000-000000000000')
        .set('Authorization', bearer);
      expect(unknown.status).toBe(404);
      expect(unknown.body.code).toBe('DOCUMENT_NOT_FOUND');

      const malformed = await http()
        .get('/documents/not-a-uuid/history')
        .set('Authorization', bearer);
      expect(malformed.status).toBe(400);
      expect(malformed.body.errors).toEqual([
        { in: 'path', name: 'id', message: 'must be a UUID' },
      ]);
    });

    it('returns no result before Completed, and the event history', async () => {
      const bearer = `Bearer ${await token()}`;
      const { body } = await submit(invoice('INV-HISTORY'));
      const result = await http()
        .get(`/documents/${body.documentId}/result`)
        .set('Authorization', bearer);
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ documentId: body.documentId, status: 'Received' });

      const history = await http()
        .get(`/documents/${body.documentId}/history`)
        .set('Authorization', bearer);
      expect(history.status).toBe(200);
      expect(history.body.history).toEqual([
        expect.objectContaining({
          version: 1,
          type: 'DocumentReceived',
          occurredAt: expect.any(String),
        }),
      ]);
    });

    it('404 NOT_FOUND as Problem Details for an unknown route', async () => {
      const res = await http()
        .get('/nope')
        .set('Authorization', `Bearer ${await token()}`);
      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
      expect(res.body.code).toBe('NOT_FOUND');
    });
  });

  describe('hardening and docs', () => {
    it('sets security headers, no CORS and no X-Powered-By', async () => {
      const res = await http().get('/health').set('Origin', 'https://evil.test');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['strict-transport-security']).toBeDefined();
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.headers['x-powered-by']).toBeUndefined();
    });

    it('echoes a valid x-correlation-id and generates one otherwise', async () => {
      const given = await http().get('/health').set('x-correlation-id', 'abc-123');
      expect(given.headers['x-correlation-id']).toBe('abc-123');
      const unsafe = await http().get('/health').set('x-correlation-id', 'bad id\twith tabs');
      expect(unsafe.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('serves OpenAPI with the bearer scheme and the Problem Details schema', async () => {
      const res = await http().get('/openapi.json');
      expect(res.status).toBe(200);
      expect(res.body.components.securitySchemes.bearer).toMatchObject({ scheme: 'bearer' });
      expect(res.body.components.schemas.ProblemDetails.properties.code.enum).toContain(
        'DUPLICATE_DOCUMENT',
      );
      expect(Object.keys(res.body.paths as object)).toEqual(
        expect.arrayContaining(['/documents', '/documents/{id}', '/documents/{id}/history']),
      );
      expect((await http().get('/docs')).status).toBe(200);
    });

    it('documents documentType as Invoice or CreditNote, and the type filter', async () => {
      const { body } = await http().get('/openapi.json');
      expect(body.components.schemas.DocumentDto.properties.documentType.enum).toEqual([
        'Invoice',
        'CreditNote',
      ]);
      const parameters = body.paths['/documents'].get.parameters as {
        name: string;
        schema: { enum?: string[] };
      }[];
      expect(parameters.find((p) => p.name === 'type')?.schema.enum).toEqual([
        'Invoice',
        'CreditNote',
      ]);
    });
  });
});

describe('HTTP API rate limit', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await startApi({ rateLimit: { limit: 2, windowMs: 60_000 } });
  });
  afterAll(async () => {
    await app.close();
  });

  it('429 RATE_LIMITED with Retry-After per organisation', async () => {
    const supplierToken = `Bearer ${await token()}`;
    const list = (bearer: string) =>
      request(app.getHttpServer() as Server)
        .get('/documents')
        .set('Authorization', bearer);

    expect((await list(supplierToken)).status).toBe(200);
    expect((await list(supplierToken)).status).toBe(200);
    const limited = await list(supplierToken);
    expect(limited.status).toBe(429);
    expect(limited.headers['content-type']).toMatch(PROBLEM_JSON);
    expect(limited.body.code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);

    // Another organisation has its own budget.
    expect((await list(`Bearer ${await token(customer)}`)).status).toBe(200);
  });
});
