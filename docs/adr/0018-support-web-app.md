# 0018. The support app in the browser: PKCE, the token in memory, a strict CSP

Status: Accepted (2026-11-13)

## Context

ADR 0017 gave support staff their own sign-in (Authorization Code + PKCE at the mock IdP, public
client `support-web`) and read-only `/support` endpoints across organisations. They still need
something to use them with: a small app in the browser that signs a support employee in, lists
documents across organisations and shows why a document failed.

A browser app is a different kind of client from everything else in this repository:

- **It is public.** Anyone can read its code, so it can hold no secret (RFC 6749 §2.1).
- **It runs next to whatever else the page loads.** A script injected into the page (XSS) acts
  with the employee's token, which reads every organisation's metadata.
- **It is reached through the edge** (ADR 0013): over HTTPS with the edge's local CA, from its own
  origin `https://localhost:5443`, which the IdP and the API already expect (ADR 0017).

The work package asked for React with no router and no state library, a handful of screens, and
no new dependencies.

## Decision

### Sign-in: Authorization Code + PKCE, checked in the browser

ADR 0017's rules, from the client's side (`apps/web/src/auth`):

- **The verifier** is 32 bytes from `crypto.getRandomValues`, base64url-encoded: 43 unreserved
  characters, RFC 7636's recommendation. The **challenge** is `S256`, computed with
  `crypto.subtle`. The tests check RFC 7636 Appendix B's example vector.
- **The state** is 16 random bytes (128 bits), new for every sign-in.
- **The verifier and the state wait in `sessionStorage`** for the one redirect to the IdP and back,
  and nowhere else. The callback removes them before it checks anything, so they are used once,
  whatever the outcome. `sessionStorage` belongs to the tab and is gone when the tab closes.
- **On `/callback`, the app first removes the code from the address bar** (`history.replaceState`),
  so it is not left in the history, in a bookmark or on screen. Then, in this order:
  - the `state` must equal the stored one, otherwise there is no sign-in from this tab to
    complete (a forged or replayed callback);
  - the `iss` must equal the configured issuer (RFC 9207: a code from another IdP is never sent to
    ours, the mix-up attack). Our IdP always sends `iss`, so a missing one is refused too;
  - an `error` from the IdP is shown with its code.
    Only then does the code go to `POST /token`, with the verifier and without a secret.
- **The redirect URI is the app's own origin plus `/callback`.** The IdP compares it exactly, so it
  is not configuration.
- **`Referrer-Policy: no-referrer`**: the callback URL carries the code until the script removes
  it, and must never leave in a `Referer` header.
- **Nothing is logged**, also not to the browser console: the app has no logging at all, and a
  test checks that neither the token nor the code reaches the console.

### The token lives in memory only

The access token is kept in the app's React state and nowhere else: not in `localStorage`,
`sessionStorage`, a cookie or a URL. It is sent only as `Authorization: Bearer` to the API, with
`credentials: 'omit'`.

- **Why memory.** Web storage is readable by any script on the origin and outlives the attack: a
  single XSS could copy a token that stays valid for its whole lifetime, and with `localStorage`
  it would survive closing the browser. In memory, the token is gone when the tab closes or
  reloads. Because it is not a cookie, the browser never attaches it on its own, so there is no
  CSRF to defend against.
- **What memory does not solve.** A script injected into the running page can still call the API
  with the token, or read it from memory. That is why the CSP below is the main defence, and why
  React renders every value as text.
- **The price: a reload means signing in again.** The sign-in screen says so. With a 15-minute
  token and a read-only tool, this is acceptable.
- **Expiry and 401.** The app keeps `expires_in` from the token response. Before each request it
  checks the expiry, and on an expired token or a `401` from the API it drops the session and shows
  the sign-in screen with the reason. There is no refresh token: the mock IdP issues none.
- **Sign out** drops the session from memory. The mock IdP keeps no login session, so there is
  nothing to end there; a real IdP would add RP-initiated logout.

**What a backend for frontend (BFF) would add.** With a BFF, the browser never holds a token: a
small server does the code exchange, keeps the tokens (and a refresh token) server-side, and gives
the browser an `HttpOnly`, `Secure`, `SameSite=Strict` session cookie. An XSS could then still
make requests while the page is open, but could not take the token away and use it elsewhere;
sessions could last longer than a token through refresh tokens, and could be revoked centrally.
It costs a stateful server with sessions, CSRF protection and a token store, while the API stays a
pure resource server (ADR 0017). For an internal, read-only tool with short tokens, memory is
proportionate. A BFF is the step up when support gets write access or longer sessions.

### Safe rendering

- **Every value is rendered as text.** React escapes strings; the app never uses
  `dangerouslySetInnerHTML`, and the tests render values that look like HTML (`<img onerror>`,
  `<script>`) and find them as text, with no element created.
- **The event data in the history** is shown as JSON text in a `<pre>`, never interpreted.
- **A status becomes a `data-status` attribute** for its colour, not part of a class name or style.
- **No third-party resources:** no fonts, CDNs or analytics. The app uses the system fonts.
- **Problem Details** (ADR 0012) are shown with their `title`, `code`, `detail` and, for a `429` or
  `503`, `Retry-After`. A response without Problem Details (a `502` from the edge) and a network
  failure (often an untrusted CA) get their own codes, `HTTP_502` and `NETWORK_ERROR`.

### Content Security Policy

The web server sends this policy with every response:

```
default-src 'self'; connect-src https://localhost:3443 https://localhost:4443; object-src 'none';
frame-ancestors 'none'; base-uri 'none'; form-action 'none'
```

- **`default-src 'self'`**: scripts, styles, images and fonts only from the app's own origin. There
  are no inline scripts or styles: Vite emits only files (`assetsInlineLimit: 0`), and React sets
  styles through the CSSOM, which `style-src` does not restrict. No `'unsafe-inline'`, no
  `'unsafe-eval'`.
- **`connect-src`** lists exactly the API and the IdP, from the same configuration as the app
  (below). An injected script cannot send the token, or anything else, to another origin with
  `fetch`. It does not include `'self'`: the app's own configuration is loaded as a script, not
  fetched.
- **`frame-ancestors 'none'`**: no clickjacking. **`base-uri 'none'`**: no injected `<base>` that
  would redirect relative URLs. **`form-action 'none'`**: the app's filter form never submits
  (it calls the API); signing in is a navigation, not a form post. **`object-src 'none'`**: no
  plugins.
- Also: `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`,
  `Cross-Origin-Opener-Policy: same-origin`, and HSTS with the stack's short max-age (ADR 0013).

### Configuration at runtime: `/config.js`

The API URL, the issuer and the client id are configuration, not code. The web server reads them
from its environment (`API_URL`, `IDP_ISSUER`, `CLIENT_ID`) and serves them as a small ES module,
`/config.js`, which the app imports at start. The same variables fill the CSP's `connect-src`, so
the app and its policy cannot disagree.

- **Runtime, not build time.** With Vite's build-time variables, the URLs would be compiled into
  the bundle, and every environment would need its own image. The published image would carry
  `localhost`. With a runtime file, one image serves every environment, the same as the service
  image.
- **A module, not JSON.** A `fetch('/config.json')` would need `'self'` in `connect-src`. An ES
  module is governed by `script-src` (`'self'`), so `connect-src` stays exactly the API and the
  IdP.
- **Checked at start.** The app refuses a configuration without a client id or with a URL that is
  not `https://`: the token and the code never travel in clear text. It then shows the problem
  instead of a sign-in button.
- `/authorize` and `/token` are taken below the issuer, as the mock IdP serves them. A real IdP
  would publish them in its discovery document (`/.well-known/openid-configuration`).

### Serving

- **A multi-stage image** (`apps/web/Dockerfile`): Node and pnpm build the bundle; the runtime
  stage is Caddy (`caddy:2.11.7-alpine`, the edge's release, pinned by digest) with the bundle and
  its configuration, and no Node.
- **A non-root, read-only server.** Caddy runs as uid 10001, on port 8080 (no capability needed),
  with a read-only root filesystem. Its storage (`/data`) is a small tmpfs owned by that user: with
  no certificates of its own, it holds only lock files. The admin API is off.
- **Plain HTTP inside the network; the edge terminates TLS.** The edge gets a third site,
  `https://localhost:5443`, with the same TLS settings, body limit and certificate authority as the
  others (ADR 0013). The `web` service publishes no ports.
- **Unknown paths serve `index.html`**, so a reload of `/callback` (or any path) loads the app.
  Paths under `/assets/` do not: a missing asset is a `404`, not an HTML page with a JavaScript
  MIME type.
- **Caching.** The hashed assets are `immutable` for a year; `index.html` is revalidated on every
  load (`no-cache`); `/config.js` is never stored (`no-store`).
- **HSTS** comes from the web server, like the API's, with the same `HSTS_MAX_AGE_SECONDS`: a year
  by default, five minutes in the compose stack.
- The release workflow publishes the image as `ghcr.io/<owner>/xml-invoice-processor-web`, for
  amd64 and arm64, like the other two. CI's e2e job builds it from each commit.

### Trusting the local CA

The edge's certificates come from Caddy's local CA. A browser lets a user click through the
warning for a page, but not for the app's `fetch` calls to `:3443` and `:4443`: they simply fail.
The README explains how to trust `.tls/edge-root-ca.crt` on macOS (Safari and Chrome) and in
Firefox, and how to remove it again. Nothing switches certificate checks off.

## Alternatives considered

- **The token in `sessionStorage`**, to survive a reload. It would be readable by any script on
  the origin for as long as the tab lives, which is exactly what memory avoids.
- **A BFF.** See above: the stronger design, for a later step.
- **Build-time configuration** (Vite env). Simpler, but one image per environment, and the CSP
  would still need the origins at runtime.
- **`connect-src 'self'` with `/config.json`.** Equally simple, but it widens the policy for one
  request at start.
- **Serving the app from the API** (Nest static files). It would put the app under the API's origin
  and CSP, next to Swagger UI, and mix a public static app into the service image.
- **nginx as the static server.** Equally good. Caddy is already the edge, so there is one server
  and one configuration language to know.
- **A router and a state library.** Four screens (sign-in, list, detail, error) fit in React state.

## Consequences

- A reload, a new tab or closing the tab means signing in again; the sign-in screen says so.
- The token cannot be refreshed: after 15 minutes the employee signs in again.
- The browser has to trust the edge's local CA. Each `docker compose down --volumes` creates a new
  CA, which has to be trusted again (and the old one removed).
- One more container (Caddy with the bundle, about 50 MB of memory in `docker stats`).
- No test runs the app in a real browser: that would need Playwright, a new dependency. The app's
  behaviour is tested with jsdom and Testing Library, the served headers and the CORS preflight
  end to end, and the PKCE flow by `support.e2e.spec.ts`.

## What production needs

- **A real IdP** with MFA (ideally phishing-resistant: FIDO2 or passkeys), conditional access,
  short sessions, and group-based assignment of `support:read` (ADR 0017).
- **Session handling:** refresh tokens with rotation and reuse detection, or a BFF; an idle
  timeout; RP-initiated logout at the IdP.
- **The IdP's discovery document** for the endpoints, instead of paths below the issuer.
- **CSP reporting** (`report-to`), and Trusted Types (`require-trusted-types-for 'script'`) once
  React's support for them is in place.
- **A public certificate** at the load balancer or CDN, which sends the same headers.

## Evidence

- `apps/web/src/auth/pkce.spec.ts`: RFC 7636 Appendix B's vector, the verifier's length and
  alphabet, and `crypto.getRandomValues` as the source.
- `apps/web/src/auth/sign-in.spec.ts`: the authorization request; the verifier and the state in
  `sessionStorage` only; a mismatched or missing `state`, another or a missing `iss` and an IdP
  error are refused without calling `/token`; a good callback exchanges the code and clears the URL
  and the stored verifier.
- `apps/web/src/App.spec.tsx`: the token never in web storage, a cookie, the URL or the console; a
  `401`, an expired token and sign out return to the sign-in screen.
- `apps/web/src/api/support-api.spec.ts`: the bearer token, the filters, the cursor, Problem
  Details, `Retry-After`.
- `apps/web/src/ui/*.spec.tsx`: the list (filters, "load more") and the detail (failure reasons,
  the history's order), HTML shown as text, Problem Details shown.
- `apps/service/test/e2e/web.e2e.spec.ts`: `/` and `/callback` through the edge with the CSP, HSTS
  and the other headers; the assets; `/config.js`; a `404` for a missing asset; the CORS preflight
  from the app's origin; no published port and a non-root user.

## Follow-ups

- A BFF, if support gets write access or longer sessions.
- A browser test (Playwright) of the sign-in, if the dependency is accepted.
- CSP reporting.
