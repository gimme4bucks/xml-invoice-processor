import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { stack } from './support/stack';
import { supportApp } from './support/support-login';

/**
 * The support app (ADR 0018) as the browser gets it: static files from the `web` service, through
 * the HTTPS edge at https://localhost:5443, with a strict CSP and HSTS. The browser part (signing
 * in, browsing) is covered by the app's own tests with jsdom; a real browser would need Playwright,
 * a new dependency. The PKCE flow itself is covered by support.e2e.spec.ts.
 */
const webUrl = process.env.WEB_BASE_URL ?? 'https://localhost:5443';
const repoRoot = path.resolve(__dirname, '../../../..');

/** `default-src 'self'; connect-src a b` as `{ 'default-src': ["'self'"], 'connect-src': [a, b] }`. */
function directives(policy: string | null): Record<string, string[]> {
  return Object.fromEntries(
    (policy ?? '')
      .split(';')
      .map((directive) => directive.trim().split(/\s+/))
      .filter(([name]) => name)
      .map(([name, ...values]) => [name!, values]),
  );
}

async function page(pathname: string): Promise<{ response: Response; html: string }> {
  const response = await fetch(`${webUrl}${pathname}`, { redirect: 'manual' });
  return { response, html: await response.text() };
}

describe('the support app at the edge (e2e)', () => {
  it('is the origin the IdP sends support staff back to', () => {
    expect(supportApp.redirectUri).toBe(`${webUrl}/callback`);
  });

  it.each([
    ['the start page', '/'],
    // A reload of the callback, or the IdP's redirect: the static server knows no such file.
    [
      'the callback',
      '/callback?code=placeholder&state=placeholder&iss=https%3A%2F%2Flocalhost%3A4443',
    ],
  ])('serves the app at %s with a strict CSP and HSTS', async (_name, pathname) => {
    const { response, html } = await page(pathname);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/html/);
    expect(html).toContain('<div id="root"></div>');
    // Every script comes from a file: no inline script that a CSP would have to allow.
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);

    const policy = response.headers.get('content-security-policy');
    expect(directives(policy)).toMatchObject({
      'default-src': ["'self'"],
      'connect-src': [stack.apiUrl, stack.idpUrl],
      'frame-ancestors': ["'none'"],
      'base-uri': ["'none'"],
      'form-action': ["'none'"],
    });
    expect(policy).not.toMatch(/unsafe-|\*|data:|http:/);
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('strict-transport-security')).toBe(stack.hsts);
  });

  it('serves the script and the stylesheet that the page references, from its own origin', async () => {
    const { html } = await page('/');
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]);

    expect(assets.length).toBeGreaterThanOrEqual(2);
    for (const asset of assets) {
      const response = await fetch(`${webUrl}${asset}`);
      expect(response.status, asset).toBe(200);
      expect(response.headers.get('content-type'), asset).toMatch(/javascript|css/);
      expect(response.headers.get('cache-control'), asset).toContain('immutable');
    }
  });

  it("answers 404 for a missing asset, instead of the app's page", async () => {
    const response = await fetch(`${webUrl}/assets/missing.js`);

    expect(response.status).toBe(404);
  });

  it("serves the stack's API, issuer and client id as /config.js, never cached", async () => {
    const response = await fetch(`${webUrl}/config.js`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/javascript/);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const config = JSON.parse(body.replace(/^export default (.*);\s*$/s, '$1')) as unknown;
    expect(config).toEqual({
      apiUrl: stack.apiUrl,
      issuer: stack.idpUrl,
      clientId: supportApp.clientId,
    });
  });

  it("allows the app's preflight to the support API, from its origin only", async () => {
    const preflight = (origin: string) =>
      fetch(`${stack.apiUrl}/support/documents?limit=20`, {
        method: 'OPTIONS',
        headers: {
          origin,
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'authorization',
        },
      });

    const fromApp = await preflight(supportApp.origin);
    expect(supportApp.origin).toBe(webUrl);
    expect(fromApp.status).toBe(204);
    expect(fromApp.headers.get('access-control-allow-origin')).toBe(webUrl);
    expect(fromApp.headers.get('access-control-allow-methods')).toContain('GET');
    expect(fromApp.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
      'authorization',
    );
    expect(fromApp.headers.get('access-control-allow-credentials')).toBeNull();

    const fromElsewhere = await preflight('https://evil.test');
    expect(fromElsewhere.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('is published only through the edge, and runs as a non-root user', async () => {
    const { stdout: config } = await promisify(execFile)(
      'docker',
      ['compose', '--profile', 'full', 'config', '--format', 'json'],
      { cwd: repoRoot },
    );
    const services = (
      JSON.parse(config) as {
        services: Record<string, { ports?: { published?: string; target: number }[] }>;
      }
    ).services;
    expect(services.web, 'a web service in the full profile').toBeDefined();
    expect(services.web?.ports ?? []).toEqual([]);
    expect(services.edge?.ports?.map((port) => `${port.published}->${port.target}`)).toContain(
      '5443->5443',
    );

    const { stdout: uid } = await promisify(execFile)(
      'docker',
      ['compose', '--profile', 'full', 'exec', '-T', 'web', 'id', '-u'],
      { cwd: repoRoot },
    );
    expect(uid.trim()).not.toBe('0');
  });
});
