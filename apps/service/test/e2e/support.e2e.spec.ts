import { beforeAll, describe, expect, it } from 'vitest';
import type {
  DocumentHistoryDto,
  SupportDocumentDto,
  SupportDocumentListDto,
} from '../../src/documents/adapters/inbound/http/document.dto';
import { Api, clients, expectBody, invoice, stack } from './support/stack';
import { claimsOf, redeem, supportApp, supportLogin } from './support/support-login';

/**
 * Support access end to end (ADR 0017): a support employee signs in at the mock IdP with
 * Authorization Code + PKCE, through the HTTPS edge, and reads the documents of both demo
 * organisations through the read-only support endpoints. Organisation and support tokens stay
 * apart in both directions.
 */
describe('support access (e2e)', () => {
  let support: Api;
  let supportToken: string;
  let supplier: Api;
  let supplierDocument: string;
  let customerDocument: string;

  beforeAll(async () => {
    supplier = await Api.as(clients.supplier);
    const customer = await Api.as(clients.customer);
    supplierDocument = await supplier.accepted(invoice('valid-sales'));
    // The customer submits the same kind of invoice: a purchase from its side, under a new number.
    customerDocument = await customer.accepted(invoice('valid-sales'));

    const login = await supportLogin();
    supportToken = login.accessToken;
    support = new Api(supportToken);
  });

  it('signs in with PKCE: a support token with sub and support:read, without an organisation', async () => {
    const claims = claimsOf(supportToken);
    expect(claims).toMatchObject({ sub: supportApp.user.username, scope: 'support:read' });
    expect(claims).not.toHaveProperty('org_id');
    expect(claims).not.toHaveProperty('peppol_id');

    // The code was redeemed in the login: it is single-use.
    const { code, verifier } = await supportLogin();
    const reused = await redeem(code, verifier);
    expect(reused.status).toBe(400);
    expect(await reused.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('lists the documents of both demo organisations', async () => {
    const all = expectBody<SupportDocumentListDto>(
      await support.get('/support/documents?limit=100'),
      200,
    );
    const ids = all.items.map((item) => item.documentId);
    expect(ids).toEqual(expect.arrayContaining([supplierDocument, customerDocument]));
    const organisations = new Set(all.items.map((item) => item.organisationId));
    expect(organisations.has('org-supplier') && organisations.has('org-customer')).toBe(true);

    for (const [organisationId, documentId] of [
      ['org-supplier', supplierDocument],
      ['org-customer', customerDocument],
    ] as const) {
      const page = expectBody<SupportDocumentListDto>(
        await support.get(`/support/documents?organisationId=${organisationId}&limit=100`),
        200,
      );
      expect(page.items.map((item) => item.documentId)).toContain(documentId);
      expect(new Set(page.items.map((item) => item.organisationId))).toEqual(
        new Set([organisationId]),
      );
    }
  });

  it("reads one organisation's document and its history, without content", async () => {
    const document = expectBody<SupportDocumentDto>(
      await support.get(`/support/documents/${customerDocument}`),
      200,
    );
    expect(document).toMatchObject({
      documentId: customerDocument,
      organisationId: 'org-customer',
      documentType: 'Invoice',
    });
    expect(document).not.toHaveProperty('result');

    const history = expectBody<DocumentHistoryDto>(
      await support.get(`/support/documents/${customerDocument}/history`),
      200,
    );
    expect(history.history[0]).toMatchObject({ version: 1, type: 'DocumentReceived' });

    const result = await support.get(`/support/documents/${customerDocument}/result`);
    expect(expectBody(result, 404).code).toBe('NOT_FOUND');
  });

  it('keeps organisation and support tokens apart', async () => {
    const own = await support.get(`/documents/${supplierDocument}`);
    expect(expectBody(own, 403).code).toBe('ORGANISATION_TOKEN_REQUIRED');
    const list = await supplier.get('/support/documents');
    expect(expectBody(list, 403).code).toBe('SUPPORT_TOKEN_REQUIRED');
  });

  it("answers CORS through the edge for the support app's origin only", async () => {
    const cors = (origin: string) =>
      fetch(`${stack.apiUrl}/support/documents?limit=1`, {
        headers: { authorization: `Bearer ${supportToken}`, origin },
      });
    const fromApp = await cors(supportApp.origin);
    expect(fromApp.status).toBe(200);
    expect(fromApp.headers.get('access-control-allow-origin')).toBe(supportApp.origin);
    const fromElsewhere = await cors('https://evil.test');
    expect(fromElsewhere.headers.get('access-control-allow-origin')).toBeNull();
  });
});
