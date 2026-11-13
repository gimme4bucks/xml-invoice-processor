import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { httpServer, startTestApi, type TestTokens, testTokens } from './support/api-tokens';

/**
 * CORS (ADR 0017): off by default. CORS_ORIGINS, an exact allow-list, opens only the support
 * endpoints, only for GET with the Authorization header, and never with credentials (cookies).
 */
const APP_ORIGIN = 'https://support.test';

describe('CORS', () => {
  let tokens: TestTokens;
  let closed: INestApplication;
  let open: INestApplication;

  beforeAll(async () => {
    tokens = await testTokens();
    closed = await startTestApi(tokens.auth);
    open = await startTestApi(tokens.auth, {}, { corsOrigins: [APP_ORIGIN] });
  });

  afterAll(async () => {
    await closed.close();
    await open.close();
  });

  const preflight = (app: INestApplication, path: string, origin: string, method = 'GET') =>
    request(httpServer(app))
      .options(path)
      .set('Origin', origin)
      .set('Access-Control-Request-Method', method)
      .set('Access-Control-Request-Headers', 'authorization');

  it('is off by default, also for the support endpoints', async () => {
    const res = await request(httpServer(closed))
      .get('/support/documents')
      .set('Origin', APP_ORIGIN)
      .set('Authorization', `Bearer ${await tokens.support()}`);
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    const options = await preflight(closed, '/support/documents', APP_ORIGIN);
    expect(options.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows a listed origin on the support endpoints, without credentials', async () => {
    const res = await request(httpServer(open))
      .get('/support/documents')
      .set('Origin', APP_ORIGIN)
      .set('Authorization', `Bearer ${await tokens.support()}`);
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(APP_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    expect(res.headers['access-control-expose-headers']).toContain('x-correlation-id');
    expect(res.headers.vary).toContain('Origin');

    // Errors too, so the browser app can read the Problem Details.
    const anonymous = await request(httpServer(open))
      .get('/support/documents')
      .set('Origin', APP_ORIGIN);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers['access-control-allow-origin']).toBe(APP_ORIGIN);
  });

  it('answers a preflight for GET with the Authorization header', async () => {
    const res = await preflight(
      open,
      '/support/documents/00000000-0000-4000-8000-000000000000/history',
      APP_ORIGIN,
    );
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(APP_ORIGIN);
    expect(res.headers['access-control-allow-methods']).toBe('GET');
    expect(res.headers['access-control-allow-headers']).toBe('Authorization');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('refuses other origins, the organisation endpoints and other methods', async () => {
    const evil = await request(httpServer(open))
      .get('/support/documents')
      .set('Origin', 'https://evil.test')
      .set('Authorization', `Bearer ${await tokens.support()}`);
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    expect(
      (await preflight(open, '/support/documents', 'https://evil.test')).headers[
        'access-control-allow-origin'
      ],
    ).toBeUndefined();

    const organisation = await request(httpServer(open))
      .get('/documents')
      .set('Origin', APP_ORIGIN)
      .set('Authorization', `Bearer ${await tokens.organisation()}`);
    expect(organisation.status).toBe(200);
    expect(organisation.headers['access-control-allow-origin']).toBeUndefined();
    expect(
      (await preflight(open, '/documents', APP_ORIGIN, 'POST')).headers[
        'access-control-allow-origin'
      ],
    ).toBeUndefined();

    const write = await preflight(open, '/support/documents', APP_ORIGIN, 'POST');
    expect(write.headers['access-control-allow-methods'] ?? '').not.toContain('POST');
  });
});
