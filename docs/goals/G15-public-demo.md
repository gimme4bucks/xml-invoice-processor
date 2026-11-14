# G15: A public demo at demo.huizeblok.nl

**Goal:** the v1.1.0 stack can run on a public VPS behind real hostnames with Let's Encrypt
certificates, so that the people in the interview can test it themselves:

- the support app at `https://demo.huizeblok.nl`;
- the API with the Swagger UI at `https://api.demo.huizeblok.nl/docs`;
- the mock IdP at `https://idp.demo.huizeblok.nl`.

The Swagger UI gets an **Authorize** button for client credentials, so a tester can submit an
invoice without curl. Local development (`localhost:3443/4443/5443` with Caddy's local CA) stays
exactly as it is.

## Context

Read `CLAUDE.md` (including **Test-driven development**), ADR 0008 (auth), ADR 0013 (the edge),
ADR 0017 (support access) and ADR 0018 (the web app).

- **Today, `localhost` is fixed in several places:**
  - the site addresses in `deploy/caddy/Caddyfile`;
  - `AUTH_ISSUER`, `API_URL`, `IDP_ISSUER`, `CORS_ORIGINS` and `MOCK_IDP_SUPPORT_REDIRECT_URIS` in `docker-compose.yml`;
  - the edge's healthcheck;
  - the URLs in `scripts/demo/demo.mts`.
- **The full profile publishes ports for Postgres, RabbitMQ (incl. management) and the S3 gateway on all interfaces.** On a public host only the edge may be reachable.
- **Demo secrets (`change-me`) live in compose.** On a public host they must come from a server-side `.env`, never from the repo.
- **The server:** a fresh Hetzner CX22 (Ubuntu 24.04, 4 GB, 2 vCPU, x86_64). The coordinator installs Docker and deploys it over SSH; you do not have access to it. It pulls the published images (`TAG=1.1.0` or a later tag); it does not build.

You run alone, so the default compose project and the full stack are yours.

## Owned paths

- `deploy/demo/**` (new): the public Caddyfile, a compose override, an env template, a short runbook
- `docker-compose.yml` and `deploy/caddy/Caddyfile`: only to make hostnames configurable, with today's localhost values as defaults, if you choose that over separate files
- `apps/service/src/shared/http/**` (OpenAPI, and the CSP of the Swagger UI if it needs the IdP origin) and `apps/service/src/shared/config.ts`
- `apps/mock-idp/**` (CORS on `/token` for the API's origin, and client authentication the Swagger UI uses)
- `scripts/demo/**`: target URLs from env, with today's defaults
- `apps/service/test/unit/**`, `apps/service/test/e2e/**` (additions), `apps/mock-idp/src/**/*.spec.ts`
- `.env.example`
- `README.md`: a "Public demo" section; `docs/adr/0019-public-demo.md` (new); this goal file

## Scope

1. **Swagger "Authorize" with client credentials:**
   - The OpenAPI document declares an OAuth2 `clientCredentials` flow next to the bearer scheme, with the `tokenUrl` from configuration (the issuer's `/token`) and the scopes `documents:submit` and `documents:read`.
   - The mock IdP's token endpoint answers CORS for the API's origin from an exact allow-list (env). It accepts the client authentication the Swagger UI sends (`client_secret_basic` and/or `client_secret_post`; check what it does).
   - If the API's CSP blocks the Swagger UI's call to the IdP, allow exactly that origin.
   - Locally, the Authorize button works at `https://localhost:3443/docs` too.
2. **A public deployment, `deploy/demo/`:**
   - Hostnames from env (`DEMO_WEB_HOST`, `DEMO_API_HOST`, `DEMO_IDP_HOST`, or similar).
   - The Caddyfile uses ACME (Let's Encrypt, with a contact e-mail from env), not `local_certs`. Keep the existing security settings:
     - admin off;
     - no plain HTTP except what ACME needs (decide between the TLS-ALPN challenge on 443 only and port 80 for HTTP-01, and justify it);
     - the request-body limit, HSTS and the headers.
   - A compose override (`docker compose -f docker-compose.yml -f deploy/demo/compose.yml --profile full …`):
     - it sets every URL, issuer, CORS origin and redirect URI to the public hosts;
     - it removes the host ports of Postgres, RabbitMQ and the S3 gateway (`ports: !reset []`);
     - the edge publishes only 443 (and 80 if ACME needs it);
     - it fixes the healthchecks that use localhost.
   - **Secrets:**
     - every password and client secret comes from a server-side `.env`;
     - `deploy/demo/.env.example` lists them without values;
     - a small script generates random ones.
     - The demo clients (`supplier-client`, `customer-client`) and the support user keep their names, so the demo story stays the same.
   - `pnpm demo` can target the public hosts (`DEMO_API_URL` etc.) and then trusts the public CAs, without `edge-root-ca.crt`.
   - A runbook (`deploy/demo/README.md`):
     - install Docker on Ubuntu 24.04;
     - open the firewall for 443 (and 80);
     - generate the `.env`, pull, up, seed with `pnpm demo`;
     - tear down.
3. **Docs:**
   - ADR 0019: what changes for a public host and why, what stays a demo (the mock IdP issues tokens to anyone with the demo credentials), and the security measures (only the edge public, generated secrets, short-lived server).
   - README: a "Public demo" section.

## Test-driven

Red, green, refactor:

- **OpenAPI:** the document contains the `clientCredentials` flow with the configured `tokenUrl` (unit).
- **The mock IdP:**
  - CORS on `/token` for an allowed origin and none for others;
  - the client authentication method(s) the Swagger UI uses (unit).
- **The CSP of `/docs`,** if you change it (unit or e2e).
- **E2E against the local full stack:**
  - a preflight from `https://localhost:3443` to the IdP's `/token` is allowed;
  - a token obtained the way the Swagger UI asks for it works on `POST /documents`.
- **The deployment** cannot be tested against Let's Encrypt here. Use a scripted check instead:
  - `docker compose -f docker-compose.yml -f deploy/demo/compose.yml --profile full config` renders;
  - only the edge publishes ports;
  - no localhost remains in the URLs;
  - no secret has a default value.
  - Show it failing before the override exists and passing after. Name it in the PR.

## Acceptance criteria

- The PR's commits put each red test before its implementation, and **How verified** shows the red and the green runs.
- `pnpm verify` exits 0, and `pnpm e2e` passes against the local full stack rebuilt from your branch.
- The local stack behaves as before; `pnpm demo` still passes locally.
- CI is green.
- A PR is open (`feat: public demo deployment and Swagger client-credentials login`).

## /goal condition

```
/goal Work package G15 in docs/goals/G15-public-demo.md is done: the Swagger UI offers an OAuth2 clientCredentials Authorize flow whose tokenUrl comes from configuration and works locally (mock IdP CORS on /token for an exact allow-list, the client authentication Swagger UI sends, the docs CSP allowing the IdP if needed); deploy/demo contains a Caddyfile with ACME for configurable public hostnames, a compose override that points every URL/issuer/CORS/redirect URI to them, publishes only the edge and takes all secrets from a generated server-side .env, plus a runbook; pnpm demo can target public URLs; ADR 0019 and a README "Public demo" section are written; you followed red-green-refactor from CLAUDE.md (red tests committed before their implementation, red and green runs shown, plus a scripted check of the rendered demo compose config); `pnpm verify` exited 0 and `pnpm e2e` and `pnpm demo` passed against the local full stack rebuilt from your branch (show the tails); and you opened a PR to main with `gh pr create` whose CI is green (show the URL and `gh pr checks`). Follow CLAUDE.md, do not add npm dependencies. Or stop after 110 turns and report what is missing.
```
