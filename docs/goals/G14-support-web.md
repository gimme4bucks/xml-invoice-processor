# G14: The support view in the browser

**Goal:** a small React app that lets a support employee sign in through the mock IdP with
Authorization Code + PKCE and follow documents across organisations, read-only. It is served over
HTTPS at `https://localhost:5443` by the full compose stack.

## Context

Read `CLAUDE.md` (including **Test-driven development**), ADR 0013 (the edge and its local CA)
and above all ADR 0017 (support access).

G13 built the backend:

- **The mock IdP:**
  - `GET /authorize` with S256, a required `state`, and `iss` in the response (RFC 9207);
  - `POST /token` with `code_verifier` and no secret;
  - public client `support-web`;
  - registered redirect URI `https://localhost:5443/callback`;
  - demo user `support-agent` (the password is in compose).
- **The API:** `GET /support/documents` (filters `organisationId`, `status`, `type`, cursor paging), `/support/documents/{id}` and `/{id}/history`. CORS is open for `https://localhost:5443` on those routes only.
- **Not available to support, by design:** the XML and the processing result.

The coordinator installed the dependencies in `apps/web/package.json`:

- runtime: React 19.3.1;
- dev: `@vitejs/plugin-react`, Testing Library and jsdom 29.1.1 (30+ needs Node 22.22; we run 22.14).

Add no others. No router and no state library: the app has a handful of screens.

You run alone, so you own the default compose project and the full stack.

## Owned paths

- `apps/web/**`: the app, its Vite/Vitest/TypeScript config, its scripts, its Dockerfile
- `deploy/caddy/Caddyfile`: a site for `https://localhost:5443`
- `docker-compose.yml`: a `web` service in the `full` profile and the edge's port 5443; nothing else changes
- `.github/workflows/*.yml`: build and publish the web image like the other two; the e2e job if it needs more
- `eslint.config.*` and `tsconfig.base.json`: only what `.tsx` needs, without new plugins
- `apps/service/test/e2e/web.e2e.spec.ts` (new)
- `README.md`: a new "Support view" section, plus the quick start where the web app appears; `docs/adr/0018-support-web-app.md` (new)

## Scope

1. **Sign in (ADR 0017's rules, client side):**
   - Generate a code verifier (43–128 unreserved characters, from `crypto.getRandomValues`) and its S256 challenge (`crypto.subtle`), and a random `state`.
   - Keep the verifier and state in `sessionStorage` only across the redirect. Remove them once used.
   - On `/callback`:
     - reject a mismatched or missing `state`, and an `iss` that is not the IdP's issuer;
     - exchange the code;
     - remove the code from the address bar (`history.replaceState`).
   - The access token lives **in memory only**: never in `localStorage`, `sessionStorage`, a cookie or a URL. A reload means signing in again; say so in the UI and the ADR.
   - Sign out drops the token. An expired token or a 401 sends the user back to sign in.
2. **Documents:**
   - A list across organisations, newest first, with filters for organisation, status and type, and "load more" via the cursor.
   - A detail view with metadata, status, failure reasons and the history as a timeline.
   - Problem Details errors (403, 404, 429 with `Retry-After`, 503) are shown with their `title` and `code`.
3. **Safe rendering:**
   - Every value is rendered as text (no `dangerouslySetInnerHTML`).
   - No third-party resources (fonts, CDNs, analytics).
   - The page is served with a strict CSP:
     - `default-src 'self'`;
     - `connect-src` only for the API and the IdP origins;
     - `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'none'`;
     - and `Referrer-Policy: no-referrer`.
   - Never log tokens or codes, including to the browser console.
4. **Configuration:** the API and IdP origins and the client id are configuration, not code. Choose build-time Vite env or a runtime `config.json` served next to the app, and justify it in the ADR. A runtime file lets one published image serve another environment.
5. **Serving:**
   - Use a multi-stage `apps/web/Dockerfile`: Node builds, a small non-root static server serves (for example `caddy:2.11.7-alpine` with `file_server`).
   - Add a compose `web` service. The edge proxies `https://localhost:5443` to it, with the same TLS and HSTS settings as the other sites.
   - Unknown paths, such as `/callback` on a reload, serve `index.html`.
6. **Trusting the local CA in a browser:**
   - The app's `fetch` calls to `https://localhost:3443` and `:4443` fail if the browser does not trust the edge's CA, and unlike a page, they cannot be clicked through.
   - In the README, document how to trust `.tls/edge-root-ca.crt` (from `pnpm tls:ca`) on macOS for Safari and Chrome, and in Firefox, and how to remove it again.
   - Never suggest disabling certificate checks.
7. **Docs:**
   - ADR 0018:
     - why the token lives in memory, and what a BFF would add;
     - the CSP;
     - configuration;
     - serving;
     - what a production version would need (a real IdP with MFA, short sessions, refresh-token rotation or a BFF).
   - README.

## Test-driven

Red, green, refactor, at the lowest level that shows each behaviour (Vitest with jsdom and
Testing Library in `apps/web`, run by `pnpm verify`):

- **PKCE helpers:** the S256 challenge of RFC 7636 Appendix B's example verifier is `E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM`; verifiers have the right length and alphabet.
- **The callback:** a mismatched or missing `state` and a wrong `iss` are rejected without calling `/token`; a good one exchanges the code and clears it from the URL.
- **The token:** it is never written to web storage, and a 401 returns to sign in.
- **The API client:** it sends the bearer token, builds the list query from the filters, follows the cursor, and maps Problem Details to errors.
- **The list and the detail render**, including a failed document's reasons and the history order. Text that looks like HTML is shown as text.
- **E2E (`web.e2e.spec.ts`, through the edge):**
  - `https://localhost:5443/` and `/callback` serve the app with the CSP and HSTS headers;
  - a preflight from that origin to `/support/documents` is allowed.
  - A real browser run is out of scope, because Playwright would be a new dependency. Say so in the PR.

## Acceptance criteria

- The PR's commits put each red test before its implementation, and **How verified** shows the red and the green runs.
- `pnpm verify` exits 0, including `apps/web`'s typecheck, tests and build.
- `pnpm e2e` passes against the full stack rebuilt from your branch, including the new spec.
- Signing in and browsing work by hand in a browser that trusts the CA. Describe what you checked in the PR, since you cannot click.
- CI is green, including the web image build.
- A PR is open (`feat: support view in the browser`).

## /goal condition

```
/goal Work package G14 in docs/goals/G14-support-web.md is done: apps/web is a React app served by a non-root static server behind the edge at https://localhost:5443 with a strict CSP; it signs in with Authorization Code + PKCE (S256 verifier from crypto.getRandomValues, state and iss checked on /callback, code removed from the URL, token in memory only, sign out and 401 back to sign in) and shows the cross-organisation document list with filters and cursor paging and a detail view with failure reasons and history, rendering every value as text and showing Problem Details errors; API/IdP origins are configuration; the web image builds in CI like the others; ADR 0018 and a README "Support view" section (including how to trust the local CA in a browser) are written; you followed red-green-refactor from CLAUDE.md (red tests committed before their implementation, red and green runs shown, including the RFC 7636 Appendix B vector); `pnpm verify` exited 0 and `pnpm e2e` passed against the rebuilt full stack including web.e2e.spec.ts (show both tails); and you opened a PR to main with `gh pr create` whose CI is green (show the URL and `gh pr checks`). Follow CLAUDE.md, add no npm dependencies beyond those already in apps/web/package.json. Or stop after 110 turns and report what is missing.
```
