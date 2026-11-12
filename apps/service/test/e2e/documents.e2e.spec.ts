import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type {
  DocumentListDto,
  HistoryEntryDto,
} from '../../src/documents/adapters/inbound/http/document.dto';
import { peppolFixture } from '../fixtures/peppol';
import { Api, clients, expectBody, freshVatNumber, invoice, stack } from './support/stack';

/**
 * The decisions of the ADRs, end to end against the full compose stack: real HTTP with mock-IdP
 * tokens, Postgres, RabbitMQ, libxml2 XSD at intake, SaxonJS Schematron and the fake VIES in the
 * worker. The fake VIES of the stack is unavailable for the first checks of every VAT number it
 * has not seen (VIES_UNAVAILABLE_TIMES_PER_NUMBER=2), so a fresh number fixes the retry count.
 */
describe('documents (e2e)', () => {
  let supplier: Api;
  let customer: Api;

  beforeAll(async () => {
    supplier = await Api.as(clients.supplier);
    customer = await Api.as(clients.customer);
  });

  const types = (history: HistoryEntryDto[]) => history.map((entry) => entry.type);

  describe('processing', () => {
    it('takes a sales invoice to Completed, with its result and its history', async () => {
      const submitted = await supplier.submit(
        invoice('valid-sales', { customerVat: freshVatNumber() }),
      );
      const { documentId } = expectBody<{ documentId: string }>(submitted, 202);
      expect(submitted.body).toEqual({ documentId, status: 'Received' });
      expect(submitted.headers.get('location')).toBe(`/documents/${documentId}`);

      const document = await supplier.waitForFinal(documentId);
      expect(document).toMatchObject({
        documentId,
        documentType: 'Invoice',
        direction: 'sales',
        status: 'Completed',
        completedAt: expect.any(String),
      });

      expect(await supplier.result(documentId)).toMatchObject({
        documentId,
        status: 'Completed',
        result: {
          direction: 'sales',
          invoice: {
            currency: 'EUR',
            supplier: { vatNumber: 'NL001234567B01' },
            totals: { payableAmount: expect.any(String) },
          },
        },
      });

      // The event stream: gapless versions, from receipt to the processed result.
      const history = await supplier.history(documentId);
      expect(history.map((entry) => entry.version)).toEqual(history.map((_, i) => i + 1));
      expect(types(history).at(0)).toBe('DocumentReceived');
      expect(types(history).slice(-2)).toEqual(['ProcessingStarted', 'DocumentProcessed']);

      const list = expectBody<DocumentListDto>(
        await supplier.get('/documents?status=Completed&limit=100'),
        200,
      );
      expect(list.items.map((item) => item.documentId)).toContain(documentId);
    });

    it('derives the direction from the token: the customer submitting it has a purchase', async () => {
      const documentId = await customer.accepted(invoice('valid-sales'));
      expect(await customer.document(documentId)).toMatchObject({ direction: 'purchase' });
    });

    it('fails a document that violates EN 16931 rules, with the BR-CO rule ids', async () => {
      // Structurally valid, so accepted: the business rules run in the worker.
      const documentId = await supplier.accepted(invoice('bad-totals'));

      const document = await supplier.waitForFinal(documentId);
      expect(document.status).toBe('Failed');
      expect(document.failure?.code).toBe('BUSINESS_RULES_VIOLATED');
      const violations = document.failure?.violations ?? [];
      expect(violations.some((v) => v.ruleId.startsWith('BR-CO-'))).toBe(true);
      expect(violations.every((v) => v.flag === 'fatal')).toBe(true);
    });

    it('retries while VIES is unavailable and then completes', async () => {
      const documentId = await supplier.accepted(
        invoice('valid-sales', { customerVat: freshVatNumber() }),
      );
      const document = await supplier.waitForFinal(documentId);
      expect(document).toMatchObject({
        status: 'Completed',
        attempts: stack.viesFailuresPerNumber + 1,
      });

      const history = await supplier.history(documentId);
      const failures = history.filter((entry) => entry.type === 'ProcessingAttemptFailed');
      expect(failures).toHaveLength(stack.viesFailuresPerNumber);
      for (const failure of failures) {
        expect(failure.event).toMatchObject({ reason: { code: 'VAT_SERVICE_UNAVAILABLE' } });
      }
      // Each retry waited in the next delay queue (retry.1, retry.2, ...) before it started.
      const started = history
        .filter((entry) => entry.type === 'ProcessingStarted')
        .map((entry) => Date.parse(entry.occurredAt));
      for (let i = 1; i < started.length; i++) {
        expect(started[i]! - started[i - 1]!).toBeGreaterThanOrEqual(stack.retryDelaysMs[i - 1]!);
      }
    });

    it('fails a document whose counterparty VAT number does not exist', async () => {
      const documentId = await supplier.accepted(
        invoice('valid-sales', { customerVat: stack.invalidVatNumber }),
      );
      const document = await supplier.waitForFinal(documentId);
      expect(document.status).toBe('Failed');
      expect(document.failure?.code).toBe('VAT_NUMBER_INVALID');
      // Failure reasons are returned and logged: they never contain the VAT number itself.
      expect(JSON.stringify(document.failure)).not.toContain(stack.invalidVatNumber);
    });
  });

  describe('intake validation', () => {
    it('rejects a document that fails the UBL 2.1 XSD with 422', async () => {
      const response = await supplier.submit(peppolFixture('missing-issue-date'));
      expect(expectBody(response, 422)).toMatchObject({
        code: 'DOCUMENT_REJECTED',
        reason: 'schema-invalid',
        errors: [expect.objectContaining({ message: expect.any(String) })],
      });
      expect(response.headers.get('content-type')).toContain('application/problem+json');
    });

    it('rejects a CreditNote as not supported yet', async () => {
      const response = await supplier.submit(peppolFixture('credit-note'));
      expect(expectBody(response, 422)).toMatchObject({
        code: 'DOCUMENT_REJECTED',
        reason: 'unsupported-document-type',
      });
    });

    it('rejects a DOCTYPE (XXE guard) without resolving it', async () => {
      const response = await supplier.submit(peppolFixture('doctype-xxe'));
      expect(expectBody(response, 422)).toMatchObject({
        code: 'DOCUMENT_REJECTED',
        reason: 'doctype-forbidden',
      });
    });
  });

  describe('idempotency', () => {
    it('answers a replay with the same document and refuses a reused key or a duplicate file', async () => {
      const key = randomUUID();
      const xml = invoice('valid-sales');
      const documentId = await supplier.accepted(xml, key);

      const replay = await supplier.submit(xml, key);
      expect(expectBody(replay, 202)).toMatchObject({ documentId });
      expect(replay.headers.get('idempotent-replayed')).toBe('true');

      const otherContent = await supplier.submit(invoice('valid-sales'), key);
      expect(expectBody(otherContent, 409)).toMatchObject({
        code: 'IDEMPOTENCY_KEY_REUSED',
        existingDocumentId: documentId,
      });

      const sameFileNewKey = await supplier.submit(xml, randomUUID());
      expect(expectBody(sameFileNewKey, 409)).toMatchObject({
        code: 'DUPLICATE_DOCUMENT',
        existingDocumentId: documentId,
      });
    });
  });

  describe('auth', () => {
    it('answers 401 without a token', async () => {
      const response = await new Api().get('/documents');
      expect(expectBody(response, 401).code).toBe('UNAUTHENTICATED');
      expect(response.headers.get('www-authenticate')).toMatch(/^Bearer/);
    });

    it('answers 403 when the token lacks the documents:submit scope', async () => {
      const readOnly = await Api.as(clients.supplier, 'documents:read');
      const response = await readOnly.submit(invoice('valid-sales'));
      expect(expectBody(response, 403).code).toBe('INSUFFICIENT_SCOPE');
    });

    it("answers 404 for another organisation's document", async () => {
      const documentId = await supplier.accepted(invoice('valid-sales'));

      for (const path of ['', '/result', '/history']) {
        const response = await customer.get(`/documents/${documentId}${path}`);
        expect(expectBody(response, 404).code).toBe('DOCUMENT_NOT_FOUND');
      }
      expect(await supplier.document(documentId)).toMatchObject({ documentId });
    });
  });
});
