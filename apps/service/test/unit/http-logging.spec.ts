import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { Writable } from 'node:stream';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInMemoryAdapters, inMemoryProviders } from '../../src/app/adapters';
import { ApiModule } from '../../src/app/modules';
import { configureHttpApp, httpAppOptions } from '../../src/shared/http/http-app';

/**
 * Request logging, in its own file: nestjs-pino keeps one pino-http instance per process, so
 * the log destination of the first app wins (vitest isolates modules per file).
 */
const fixture = readFileSync(join(__dirname, '../fixtures/invoice-minimal.xml'));
const ISSUER = 'https://idp.test';
const AUDIENCE = 'xml-invoice-processor';

describe('HTTP API logging', () => {
  const lines: string[] = [];
  let app: INestApplication;
  let bearer: string;

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k', alg: 'ES256' };
    bearer = await new SignJWT({
      org_id: 'org-supplier',
      peppol_id: '0106:11111111',
      scope: 'documents:submit documents:read',
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'k' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject('client-1')
      .setExpirationTime('5m')
      .sign(privateKey);

    const destination = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(...chunk.toString().split('\n').filter(Boolean));
        done();
      },
    });
    const moduleRef = await Test.createTestingModule({
      imports: [
        ApiModule.register(inMemoryProviders(createInMemoryAdapters()), {
          auth: { issuer: ISSUER, audience: AUDIENCE, keys: createLocalJWKSet({ keys: [jwk] }) },
          logging: { level: 'info', destination },
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication(httpAppOptions);
    configureHttpApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('logs the correlation id and organisation, never the token or the body', async () => {
    const res = await request(app.getHttpServer() as Server)
      .post('/documents')
      .set('Authorization', `Bearer ${bearer}`)
      .set('Content-Type', 'application/xml')
      .set('Idempotency-Key', 'key-logging')
      .set('x-correlation-id', 'corr-logging-1')
      .send(fixture);
    expect(res.status).toBe(202);

    const completed = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.correlationId === 'corr-logging-1' && entry.res);
    expect(completed).toMatchObject({
      organisationId: 'org-supplier',
      req: { method: 'POST', url: '/documents', headers: { authorization: '[redacted]' } },
      res: { statusCode: 202 },
    });
    const output = lines.join('\n');
    expect(output).not.toContain(bearer);
    expect(output).not.toContain('INV-2026-0042');
    expect(output).not.toContain('NL001234567B01');
  });
});
