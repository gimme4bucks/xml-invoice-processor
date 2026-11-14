# 0019. A public demo: real hostnames, Let's Encrypt and a Swagger UI login

Status: Accepted (2026-11-14)

## Context

The interviewers should be able to try the stack themselves, from their own browsers, without
cloning the repository: the support app, the API's Swagger UI and the mock IdP on real hostnames
(`demo.huizeblok.nl`, `api.demo.huizeblok.nl`, `idp.demo.huizeblok.nl`), on one small VPS (Hetzner
CX22, Ubuntu 24.04) that lives for a few days.

The local full stack (ADR 0013, ADR 0018) is not fit for that as it is:

- `localhost` is fixed in the edge's site addresses, in every issuer, URL, CORS origin and
  redirect URI, and in the edge's healthcheck;
- its certificates come from Caddy's local CA, which no browser trusts;
- it publishes Postgres, RabbitMQ (with its management UI) and the S3 gateway on all interfaces;
- its passwords and client secrets are demo defaults (`change-me`, `xip`) in the repository.

And trying the API meant curl: getting a token, then pasting it into Swagger UI's bearer field.

## Decision

- **A Swagger UI login with client credentials.**
  - With `AUTH_TOKEN_URL` set (the IdP's `/token`), the OpenAPI document declares an OAuth2
    scheme `client-credentials` with the scopes `documents:submit` and `documents:read`, offered
    next to the bearer token on every operation outside `/support`. A tester types a demo client's
    id and secret under **Authorize**, and Swagger UI fetches the token itself. Unset, nothing
    changes.
  - The `/support` endpoints do not get it: their tokens come from Authorization Code + PKCE
    (ADR 0017), and offering an organisation login there would only produce 403s.
  - Swagger UI asks for the token from the browser: a cross-origin POST with the client in a Basic
    header (its only option for this flow) and `X-Requested-With`. So the mock IdP answers CORS on
    `/token` for an exact allow-list (`MOCK_IDP_CORS_ORIGINS`: the API's origin), next to the
    support app's origin it already allowed. The preflight allows `Authorization`, `Content-Type`
    and `X-Requested-With`, never credentials (there are no cookies).
  - The API's CSP (helmet) has no `connect-src`, so `default-src 'self'` would block that call.
    With a token URL, `connect-src` is `'self'` plus exactly the token URL's origin.
  - Swagger UI sends `scope=` empty when no scope is ticked. The IdP now treats an empty scope like
    a missing one and grants the client's scopes (RFC 6749 §3.3), instead of a token without any
    scope.
  - Locally the same works at `https://localhost:3443/docs` (once the browser trusts the edge's
    root, see the README).
- **The public deployment is an override, not a second stack.** `deploy/demo/compose.yml` goes on
  top of `docker-compose.yml`, and `deploy/demo/Caddyfile` replaces the edge's configuration. The
  local stack stays exactly as it is, and the demo runs the same services, images and settings
  apart from what a public host needs:
  - every issuer, URL, CORS origin and redirect URI is built from `DEMO_WEB_HOST`,
    `DEMO_API_HOST` and `DEMO_IDP_HOST`;
  - the images are the published ones of `TAG` (required); the server pulls and never builds.
- **Certificates from Let's Encrypt over TLS-ALPN-01, on 443 only.**
  - The ACME issuer is Let's Encrypt with a contact address (`ACME_EMAIL`); the HTTP-01 challenge
    is switched off, so Caddy opens no plain HTTP listener and port 80 stays closed. ADR 0013's
    rule holds: no plain HTTP, no redirect.
  - The edge still runs as uid 10001 on a read-only root filesystem, so it listens on 8443 and
    compose publishes that as 443. The admin API stays off, HTTP/3 stays off, the request-body
    limit stays at 1100 KiB, and HSTS and the other headers still come from the services.
  - The certificates and the ACME account live in the `edge-data` volume, so restarts do not
    request new ones (Let's Encrypt allows five per set of hostnames per week).
  - `ACME_CA` can point to Let's Encrypt's staging directory for a dry run.
  - The edge's healthcheck makes a verified request to each public host against the image's
    public CAs, so `up --wait` returns only once the certificates are there.
- **Only the edge is reachable.** Postgres, RabbitMQ and the S3 gateway lose their host ports
  (`ports: !reset []`). This is done in compose, not left to the firewall: Docker's published ports
  bypass ufw.
- **Secrets only from a server-side `.env`.**
  - Every password and client secret in the override is `${VAR:?}`: compose refuses to start
    without it, so a forgotten secret cannot fall back to a demo default.
  - `deploy/demo/generate-env.sh` writes `deploy/demo/.env` (gitignored, mode 600, never
    overwritten) with 48 random hex characters per secret, safe in URLs, JSON and Basic auth.
    `deploy/demo/.env.example` lists the names without values.
  - The demo clients and the support user keep their names (`supplier-client`,
    `customer-client`, `support-agent`) and claims, so the demo story stays the same.
- **`pnpm demo` against the public hosts.** With a non-localhost `API_BASE_URL`, it runs without
  the local edge's CA and relies on Node's public CAs. Verification is never switched off.
- **A scripted check instead of a test against Let's Encrypt.** `deploy/demo/check-config.mts`
  renders the configuration with the template's variables filled in and checks that only the edge
  publishes a port (443), that no `localhost` remains, that every URL names a public host, that
  rendering fails without any one secret and that no demo default remains. It also has Caddy
  validate the Caddyfile offline and checks its listener and ACME issuer.

## What stays a demo

- **The mock IdP issues tokens to anyone with the demo credentials.** It is not an identity
  provider: no user management, no rate limit on `/token`, no revocation, a signing key that
  changes on every restart. The testers get the client secrets and the support password, and with
  them the full rights of two demo organisations and of support staff.
- **The data is demo data.** Documents submitted there are visible to whoever holds the same
  demo client's secret. No real invoices.
- The fake VIES, the short retry delays and the 90-second sweeper of the compose stack stay, so
  that the retry path shows up within a demo.
- HSTS keeps the stack's five minutes: the server lives for days, and nothing is gained by pinning
  browsers to these hostnames for a year.

## Security measures

- One open port, 443, terminated by Caddy with publicly trusted certificates; no plain HTTP at all.
- Generated secrets that exist only on the server; no default can be used by mistake.
- No database, broker or object store port on the host; their management UIs are unreachable.
- The rest is unchanged: non-root, read-only containers; the admin API off; CORS by exact
  allow-list; organisation scoping from the token; no secrets or tokens in the logs.
- A short-lived server: up for the demo, then `down --volumes` and deleted, with its DNS records.

## Alternatives considered

- **A Swagger UI login through the API (a proxy for `/token`).** It would avoid CORS on the IdP,
  but the API would handle client secrets, which it never does with a real IdP. CORS on the IdP for
  one exact origin is what a real IdP offers for this.
- **Prefilled credentials in Swagger UI (`initOAuth`).** The secret would be in the page for anyone
  who opens it. The testers type it.
- **HTTP-01 on port 80.** Better known, but it needs a plain HTTP listener on the internet.
  TLS-ALPN-01 needs nothing beyond 443, which is open anyway.
- **Hostnames as variables in the existing Caddyfile and compose file.** One file fewer, but
  every local setting would turn into a variable with a default, and the demo would depend on the
  local defaults being overridden everywhere. A separate override keeps the local stack untouched
  and makes the differences readable in one file.
- **A managed platform (Kubernetes, a PaaS).** More to set up and explain than one VM with compose
  for a stack that lives for a few days.

## Consequences

- The interviewers can submit an invoice from the Swagger UI and follow it in the support app, on
  their own machines.
- Anyone with the demo secrets can use the demo; that is its purpose, and it is why it runs on a
  separate, short-lived server with demo data only.
- A release later than 1.1.0 has to be published first: the 1.1.0 images do not know
  `AUTH_TOKEN_URL` and `MOCK_IDP_CORS_ORIGINS`.
- The demo override has to follow `docker-compose.yml`: a new secret or URL there needs its entry
  in `deploy/demo/compose.yml`. The scripted check catches a URL that still names `localhost` and
  a demo default that survives.
