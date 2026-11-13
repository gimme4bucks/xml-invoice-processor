# G08: HTTPS at the edge

**Goal:** clients reach the API and the mock IdP only over HTTPS. TLS ends at a reverse proxy
(Caddy) in front of them, as a load balancer or ingress would do it in production. The Node
processes keep speaking plain HTTP inside the compose network.

## Context

Read `CLAUDE.md` (including **Test-driven development**), the README and ADR 0008 (auth). v1.0.0
is released, and reviewers may be reading `main`, so the quick start must keep working at every
merge. G09 (the unhappy path) runs at the same time and touches the worker, the domain and a few
lines of `docker-compose.yml` and `.env.example`, so keep your edits there focused.

## Owned paths

- `docker-compose.yml`, `deploy/caddy/**` (new), `.env.example`, `.gitignore`
- `scripts/demo/**`, `scripts/tls/**` (new), `examples/**`, root `package.json` `scripts`
- `apps/service/test/e2e/**`
- `apps/service/src/main-api.ts`, `apps/service/src/shared/http/**`, `apps/service/src/shared/config.ts` (trusting the proxy)
- `.github/workflows/ci.yml` (only the `e2e` job)
- `README.md`: the intro ("over HTTPS"), Quick start, the URL table, **Check that it really ran**, Security
- `docs/adr/0013-tls-at-the-edge.md` (new)

## Scope

1. **Caddy in compose:** a service `edge` (profile `full`) with an exact, pinned image version that is at least two weeks old.
   - It terminates TLS for the API on `https://localhost:3443` and for the mock IdP on `https://localhost:4443`, with Caddy's internal CA.
   - The CA lives in a named volume, so it survives restarts; `down --volumes` resets it.
   - The `api` and `mock-idp` services no longer publish ports to the host.
   - Harden it like the other services: read-only root filesystem where possible, admin API not published, a healthcheck so that `up --wait` waits for it.
2. **No plain HTTP from outside:** there is no redirect from HTTP to HTTPS. For an API, the client secret or token would already have been sent in clear text before the redirect, so a plain request must fail. Explain this in the ADR.
3. **Tokens and issuer:**
   - `AUTH_ISSUER` becomes `https://localhost:4443`. It is compared only as a string.
   - The API keeps fetching the JWKS inside the network (`http://mock-idp:4000`).
   - In production, the JWKS comes from the real IdP over HTTPS (ADR).
4. **Trusting the CA, never bypassing it:**
   - A script exports Caddy's root certificate to a gitignored path.
   - `pnpm demo` and `pnpm e2e` trust it (`NODE_EXTRA_CA_CERTS`), and the curl examples use `--cacert`.
   - Nothing a reviewer might copy disables verification: no `-k`, no `NODE_TLS_REJECT_UNAUTHORIZED=0`, no `rejectUnauthorized: false`.
   - The reviewer path stays copy-pasteable: `docker compose --profile full up -d --wait`, `pnpm demo`, `pnpm e2e`, with no manual certificate steps.
5. **Behind the proxy:**
   - The API trusts exactly one proxy hop, so a client cannot spoof `X-Forwarded-For`. Use a setting that is off by default and on in compose.
   - Responses carry HSTS (helmet already sends it; check it).
   - A request-size limit at the edge, slightly above the API's 1 MiB, as defence in depth.
6. **Docs:**
   - ADR 0013, TLS at the edge: the alternatives (TLS in Node, a Traefik/nginx proxy, mTLS for B2B), internal traffic (Postgres, RabbitMQ, JWKS) staying plain inside the network with TLS in production, and local development (`pnpm infra:up`) staying plain HTTP on the loopback interface.
   - README: every URL and command updated, plus the wording "over HTTPS".
   - `.env.example` and the CI `e2e` job updated.

## Test-driven

Start with e2e tests that fail against the current stack. Commit them first, then make them pass:

- the API and the IdP answer over HTTPS when the exported CA is trusted;
- the same request fails certificate verification without the CA (proof that TLS is real and verified);
- plain HTTP to the public ports fails and does not redirect;
- `/health` and API responses carry `Strict-Transport-Security`.

Trusting the proxy gets a unit test first (a spoofed `X-Forwarded-For` from a client is not believed).

## Acceptance criteria

- The new e2e tests were red before the change (show the run) and are green after it. All existing e2e tests and `pnpm demo` pass over HTTPS in CI.
- `pnpm verify` exits 0.
- A PR is open (`feat: HTTPS at the edge with Caddy`) whose commits put the red tests before the implementation.

## /goal condition

```
/goal Work package G08 in docs/goals/G08-https.md is done: the full compose stack serves the API on https://localhost:3443 and the mock IdP on https://localhost:4443 through Caddy, the api and mock-idp publish no host ports, plain HTTP fails without a redirect, and nothing disables certificate verification; you followed red-green-refactor from CLAUDE.md: the new e2e tests (HTTPS with the exported CA, verification fails without it, plain HTTP refused, HSTS) were committed before the implementation and you showed their red run; after the change every e2e test passes and `pnpm demo` runs cleanly over HTTPS against the stack (show both outputs); `pnpm verify` exited 0 (show the tail); ADR 0013 and the README are updated; and you opened a PR to main with `gh pr create` whose CI is green (show the URL and `gh pr checks`). Follow CLAUDE.md, do not add npm dependencies. Or stop after 70 turns and report what is missing.
```
