import { describe, expect, it } from 'vitest';
import { Api, clients, expectBody, invoice, stack } from './support/stack';

/**
 * The Swagger UI's Authorize button (ADR 0019): the page at /docs asks the IdP for a
 * client-credentials token from the browser, so the IdP must answer CORS for the API's origin and
 * the API's CSP must let the page connect to the IdP. Without a browser (Playwright would be a new
 * dependency), these tests send exactly the requests Swagger UI 5 sends.
 */
const tokenUrl = `${stack.idpUrl}/token`;

describe('the Swagger UI login with client credentials (e2e)', () => {
  it('declares the flow with the IdP token URL behind the edge', async () => {
    const document = (await (await fetch(`${stack.apiUrl}/openapi.json`)).json()) as {
      components: { securitySchemes: Record<string, { flows?: unknown }> };
    };

    expect(document.components.securitySchemes['client-credentials']?.flows).toMatchObject({
      clientCredentials: { tokenUrl },
    });
  });

  it("lets the /docs page connect to the IdP's origin", async () => {
    const response = await fetch(`${stack.apiUrl}/docs`);

    expect(response.headers.get('content-security-policy')).toMatch(
      new RegExp(`(^|;)connect-src 'self' ${stack.idpUrl.replace(/[.]/g, '\\.')}(;|$)`),
    );
  });

  it("allows the browser's preflight from the API's origin to the token endpoint", async () => {
    const response = await fetch(tokenUrl, {
      method: 'OPTIONS',
      headers: {
        Origin: stack.apiUrl,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type,x-requested-with',
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(stack.apiUrl);
    expect(response.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
      'x-requested-with',
    );
  });

  it('issues a token the way Swagger UI asks for it, and the API accepts it', async () => {
    const { id, secret } = clients.supplier;
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        Origin: stack.apiUrl,
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
        Authorization: `Basic ${btoa(`${id}:${secret}`)}`,
      },
      // No scope ticked in the dialog.
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: '' }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(stack.apiUrl);
    const { access_token } = (await response.json()) as { access_token: string };

    const submitted = await new Api(access_token).submit(invoice('valid-sales'));

    expectBody(submitted, 202);
  });
});
