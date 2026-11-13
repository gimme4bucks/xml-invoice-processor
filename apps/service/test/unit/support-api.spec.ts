import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toSupportDocumentDto } from '../../src/documents/adapters/inbound/http/document.dto';
import { peppolFixture } from '../fixtures/peppol';
import {
  customer,
  httpServer,
  startTestApi,
  supplier,
  type TestTokens,
  testTokens,
} from './support/api-tokens';

/**
 * Support access (ADR 0017): support tokens (no org_id, scope support:read) reach only the
 * read-only /support endpoints, across organisations; organisation tokens reach only theirs.
 */
const fixture = readFileSync(join(__dirname, '../fixtures/invoice-minimal.xml'));
const invoice = (number: string) =>
  Buffer.from(fixture.toString().replace('INV-2026-0042', number));
const PROBLEM_JSON = /^application\/problem\+json/;
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

/** Everything a support response may say about a document: metadata, never content. */
const SUPPORT_FIELDS = [
  'documentId',
  'organisationId',
  'documentType',
  'direction',
  'status',
  'attempts',
  'failure',
  'receivedAt',
  'updatedAt',
  'completedAt',
];

describe('support access (ADR 0017)', () => {
  let tokens: TestTokens;
  let app: INestApplication;
  const http = () => request(httpServer(app));
  const get = (path: string, token: string) =>
    http().get(path).set('Authorization', `Bearer ${token}`);

  let supplierDocument: string;
  let customerDocument: string;
  let customerCreditNote: string;

  async function submit(xml: Buffer, org: typeof supplier): Promise<string> {
    const res = await http()
      .post('/documents')
      .set('Authorization', `Bearer ${await tokens.organisation(org)}`)
      .set('Content-Type', 'application/xml')
      .set('Idempotency-Key', `key-${Math.random()}`)
      .send(xml);
    expect(res.status).toBe(202);
    return res.body.documentId as string;
  }

  beforeAll(async () => {
    tokens = await testTokens();
    app = await startTestApi(tokens.auth);
    supplierDocument = await submit(invoice('INV-SUPPORT-1'), supplier);
    customerDocument = await submit(invoice('INV-SUPPORT-2'), customer);
    customerCreditNote = await submit(peppolFixture('credit-note'), customer);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('organisation and support tokens are kept apart', () => {
    it('403 ORGANISATION_TOKEN_REQUIRED for a token without org_id on every organisation endpoint', async () => {
      const support = await tokens.support();
      const noOrganisation = await tokens.support('client-without-org', 'documents:read');
      for (const token of [support, noOrganisation]) {
        for (const path of [
          '/documents',
          `/documents/${supplierDocument}`,
          `/documents/${supplierDocument}/result`,
          `/documents/${supplierDocument}/history`,
        ]) {
          const res = await get(path, token);
          expect(res.status, path).toBe(403);
          expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
          expect(res.body.code).toBe('ORGANISATION_TOKEN_REQUIRED');
        }
      }
      const submitted = await http()
        .post('/documents')
        .set('Authorization', `Bearer ${support}`)
        .set('Content-Type', 'application/xml')
        .set('Idempotency-Key', 'key-support-submit')
        .send(invoice('INV-SUPPORT-SUBMIT'));
      expect(submitted.status).toBe(403);
      expect(submitted.body.code).toBe('ORGANISATION_TOKEN_REQUIRED');
    });

    it('403 SUPPORT_TOKEN_REQUIRED for an organisation token on every support endpoint', async () => {
      const organisation = await tokens.organisation();
      // Even an organisation token that claims support:read is not a support token.
      const claimsSupport = await tokens.organisation(supplier, 'documents:read support:read');
      for (const token of [organisation, claimsSupport]) {
        for (const path of [
          '/support/documents',
          `/support/documents/${supplierDocument}`,
          `/support/documents/${supplierDocument}/history`,
        ]) {
          const res = await get(path, token);
          expect(res.status, path).toBe(403);
          expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
          expect(res.body.code).toBe('SUPPORT_TOKEN_REQUIRED');
        }
      }
    });

    it('403 INSUFFICIENT_SCOPE for a support token without support:read', async () => {
      const res = await get('/support/documents', await tokens.support('support-bob', 'profile'));
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'INSUFFICIENT_SCOPE', requiredScope: 'support:read' });
    });

    it('401 without a token, and for a token with a peppol_id but no org_id', async () => {
      const anonymous = await http().get('/support/documents');
      expect(anonymous.status).toBe(401);
      expect(anonymous.body.code).toBe('UNAUTHENTICATED');

      const odd = await tokens.signed({ peppol_id: supplier.peppol_id, scope: 'support:read' });
      const res = await get('/support/documents', odd);
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Bearer error="invalid_token"');
    });
  });

  describe('GET /support/documents', () => {
    it('lists the documents of every organisation, newest first, with their organisation', async () => {
      const res = await get('/support/documents', await tokens.support());
      expect(res.status).toBe(200);
      const items = res.body.items as Array<Record<string, unknown>>;
      expect(items.map((item) => item.documentId)).toEqual([
        customerCreditNote,
        customerDocument,
        supplierDocument,
      ]);
      expect(items.map((item) => item.organisationId)).toEqual([
        'org-customer',
        'org-customer',
        'org-supplier',
      ]);
      for (const item of items) {
        expect(SUPPORT_FIELDS).toEqual(expect.arrayContaining(Object.keys(item)));
      }
    });

    it('filters by organisationId, status and type, and pages with a cursor', async () => {
      const support = await tokens.support();
      const ids = async (query: string) =>
        (
          (await get(`/support/documents?${query}`, support)).body.items as Array<{
            documentId: string;
          }>
        ).map((item) => item.documentId);

      expect(await ids('organisationId=org-supplier')).toEqual([supplierDocument]);
      expect(await ids('organisationId=org-customer&type=CreditNote')).toEqual([
        customerCreditNote,
      ]);
      expect(await ids('type=Invoice')).toEqual([customerDocument, supplierDocument]);
      expect(await ids('status=Completed')).toEqual([]);

      const first = await get('/support/documents?limit=2', support);
      expect(first.body.items).toHaveLength(2);
      const next = await http()
        .get('/support/documents')
        .query({ limit: 2, cursor: first.body.nextCursor as string })
        .set('Authorization', `Bearer ${support}`);
      expect(next.body.items.map((item: { documentId: string }) => item.documentId)).toEqual([
        supplierDocument,
      ]);
      expect(next.body.nextCursor).toBeUndefined();
    });

    it.each([
      'limit=0',
      'limit=101',
      'status=Done',
      'type=Order',
      'organisationId=',
      `organisationId=${'x'.repeat(129)}`,
      'org_id=org-supplier',
    ])('400 INVALID_REQUEST for ?%s', async (query) => {
      const res = await get(`/support/documents?${query}`, await tokens.support());
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_REQUEST');
      expect(res.body.errors[0].in).toBe('query');
    });
  });

  describe('GET /support/documents/{id} and /history', () => {
    it("returns any organisation's document: metadata and status, never XML or the result", async () => {
      const support = await tokens.support();
      for (const [id, organisationId] of [
        [supplierDocument, 'org-supplier'],
        [customerCreditNote, 'org-customer'],
      ]) {
        const res = await get(`/support/documents/${id}`, support);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ documentId: id, organisationId, status: 'Received' });
        expect(SUPPORT_FIELDS).toEqual(expect.arrayContaining(Object.keys(res.body as object)));
      }
    });

    it('returns the event history of any organisation', async () => {
      const res = await get(
        `/support/documents/${customerDocument}/history`,
        await tokens.support(),
      );
      expect(res.status).toBe(200);
      expect(res.body.documentId).toBe(customerDocument);
      expect(res.body.history).toEqual([
        expect.objectContaining({ version: 1, type: 'DocumentReceived' }),
      ]);
    });

    it('404 DOCUMENT_NOT_FOUND for an unknown id and 400 for a malformed one', async () => {
      const support = await tokens.support();
      for (const path of [
        `/support/documents/${UNKNOWN_ID}`,
        `/support/documents/${UNKNOWN_ID}/history`,
      ]) {
        const res = await get(path, support);
        expect(res.status, path).toBe(404);
        expect(res.body.code).toBe('DOCUMENT_NOT_FOUND');
      }
      const malformed = await get('/support/documents/not-a-uuid', support);
      expect(malformed.status).toBe(400);
      expect(malformed.body.errors).toEqual([
        { in: 'path', name: 'id', message: 'must be a UUID' },
      ]);
    });

    it('has no endpoint for the result or the XML, and nothing that writes', async () => {
      const support = `Bearer ${await tokens.support()}`;
      for (const path of ['result', 'original', 'xml']) {
        const res = await http()
          .get(`/support/documents/${supplierDocument}/${path}`)
          .set('Authorization', support);
        expect(res.status, path).toBe(404);
        expect(res.body.code).toBe('NOT_FOUND');
      }
      const write = await http()
        .post('/support/documents')
        .set('Authorization', support)
        .set('Content-Type', 'application/xml')
        .send(invoice('INV-SUPPORT-WRITE'));
      expect(write.status).toBe(404);
    });

    it('maps a view field by field: failure and completion, but no version', () => {
      const dto = toSupportDocumentDto({
        documentId: UNKNOWN_ID,
        organisationId: 'org-1',
        documentType: 'Invoice',
        direction: 'sales',
        status: 'Failed',
        attempts: 2,
        failure: { code: 'VAT_NUMBER_INVALID', message: 'no such number' },
        receivedAt: new Date('2026-11-13T10:00:00.000Z'),
        updatedAt: new Date('2026-11-13T10:01:00.000Z'),
        completedAt: new Date('2026-11-13T10:01:00.000Z'),
        version: 4,
      });
      expect(dto).toEqual({
        documentId: UNKNOWN_ID,
        organisationId: 'org-1',
        documentType: 'Invoice',
        direction: 'sales',
        status: 'Failed',
        attempts: 2,
        failure: { code: 'VAT_NUMBER_INVALID', message: 'no such number' },
        receivedAt: '2026-11-13T10:00:00.000Z',
        updatedAt: '2026-11-13T10:01:00.000Z',
        completedAt: '2026-11-13T10:01:00.000Z',
      });
    });
  });

  describe('OpenAPI', () => {
    it('documents the support endpoints and the new problem codes', async () => {
      const { body } = await http().get('/openapi.json');
      expect(Object.keys(body.paths as object)).toEqual(
        expect.arrayContaining([
          '/support/documents',
          '/support/documents/{id}',
          '/support/documents/{id}/history',
        ]),
      );
      expect(Object.keys(body.paths as object)).not.toContain('/support/documents/{id}/result');
      const parameters = (
        body.paths['/support/documents'].get.parameters as { name: string }[]
      ).map((p) => p.name);
      expect(parameters).toEqual(
        expect.arrayContaining(['organisationId', 'status', 'type', 'limit', 'cursor']),
      );
      expect(body.components.schemas.ProblemDetails.properties.code.enum).toEqual(
        expect.arrayContaining(['ORGANISATION_TOKEN_REQUIRED', 'SUPPORT_TOKEN_REQUIRED']),
      );
      expect(body.components.schemas.SupportDocumentDto.properties).toHaveProperty(
        'organisationId',
      );
    });
  });
});
