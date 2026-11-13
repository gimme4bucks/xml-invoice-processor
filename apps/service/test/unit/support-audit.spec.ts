import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { httpServer, startTestApi, type TestTokens, testTokens } from './support/api-tokens';

/**
 * The audit line of support access (ADR 0017), in its own file: nestjs-pino keeps one pino-http
 * instance per process, so the log destination of the first app wins.
 */
const fixture = readFileSync(join(__dirname, '../fixtures/invoice-minimal.xml'));
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

describe('support audit log', () => {
  const lines: string[] = [];
  let tokens: TestTokens;
  let app: INestApplication;
  let supportToken: string;
  let organisationToken: string;
  let documentId: string;

  const entries = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const auditLines = (correlationId: string) =>
    entries().filter(
      (entry) => entry.audit === 'support-access' && entry.correlationId === correlationId,
    );
  const asSupport = (path: string, correlationId: string) =>
    request(httpServer(app))
      .get(path)
      .set('Authorization', `Bearer ${supportToken}`)
      .set('x-correlation-id', correlationId);

  beforeAll(async () => {
    tokens = await testTokens();
    const destination = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(...chunk.toString().split('\n').filter(Boolean));
        done();
      },
    });
    app = await startTestApi(tokens.auth, { logging: { level: 'info', destination } });
    supportToken = await tokens.support('support-alice');
    organisationToken = await tokens.organisation();
    const submitted = await request(httpServer(app))
      .post('/documents')
      .set('Authorization', `Bearer ${organisationToken}`)
      .set('Content-Type', 'application/xml')
      .set('Idempotency-Key', 'key-audit')
      .set('x-correlation-id', 'corr-audit-submit')
      .send(fixture);
    expect(submitted.status).toBe(202);
    documentId = submitted.body.documentId as string;
  });

  afterAll(async () => {
    await app.close();
  });

  it('logs one line per list request: who, the endpoint, the filters and the correlation id', async () => {
    const res = await asSupport(
      '/support/documents?organisationId=org-supplier&status=Received&limit=5',
      'corr-audit-list',
    );
    expect(res.status).toBe(200);
    const audit = auditLines('corr-audit-list');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      sub: 'support-alice',
      endpoint: 'GET /support/documents',
      filters: { organisationId: 'org-supplier', status: 'Received', limit: '5' },
      correlationId: 'corr-audit-list',
    });
    expect(audit[0]).not.toHaveProperty('documentId');
  });

  it('logs the document id for a document and its history, found or not', async () => {
    expect((await asSupport(`/support/documents/${documentId}`, 'corr-audit-get')).status).toBe(
      200,
    );
    expect(auditLines('corr-audit-get')).toEqual([
      expect.objectContaining({
        sub: 'support-alice',
        endpoint: 'GET /support/documents/:id',
        documentId,
      }),
    ]);

    const history = await asSupport(`/support/documents/${documentId}/history`, 'corr-audit-hist');
    expect(history.status).toBe(200);
    expect(auditLines('corr-audit-hist')).toEqual([
      expect.objectContaining({ endpoint: 'GET /support/documents/:id/history', documentId }),
    ]);

    const missing = await asSupport(`/support/documents/${UNKNOWN_ID}`, 'corr-audit-missing');
    expect(missing.status).toBe(404);
    expect(auditLines('corr-audit-missing')).toEqual([
      expect.objectContaining({ documentId: UNKNOWN_ID }),
    ]);
  });

  it('writes no audit line for organisation requests, and never the token or the content', async () => {
    const own = await request(httpServer(app))
      .get(`/documents/${documentId}`)
      .set('Authorization', `Bearer ${organisationToken}`)
      .set('x-correlation-id', 'corr-audit-own');
    expect(own.status).toBe(200);
    expect(auditLines('corr-audit-own')).toEqual([]);

    const output = lines.join('\n');
    expect(output).not.toContain(supportToken);
    expect(output).not.toContain(organisationToken);
    expect(output).not.toContain('INV-2026-0042');
    expect(output).not.toContain('NL001234567B01');
  });
});
