# G05: HTTP API & security

**Goal:** the public HTTP API with authentication, authorisation, input hardening, Problem
Details, rate limiting, logging and OpenAPI, plus the mock IdP.

## Context

- Read `CLAUDE.md` and ADRs 0007, 0008, 0012.
- Use cases already exist: `SubmitDocumentCommand` and the queries in `application/queries/document-queries.ts`.
- The API runs in-memory today: `ADAPTERS=in-memory`.

## Owned paths

- `apps/service/src/documents/adapters/inbound/http/**`
- `apps/service/src/shared/**`
- `apps/mock-idp/**`
- `apps/service/test/unit/http*.spec.ts`
- In `src/app/modules.ts`, **only the `ApiModule` section**, and `src/main-api.ts` (bootstrap)

## Scope

1. **Endpoints:**
   - **`POST /documents`:**
     - Body is raw `application/xml`, at most 1 MB, enforced **before** parsing (413). Any other Content-Type gives 415. Only UTF-8 is accepted.
     - The `Idempotency-Key` header is required and validated (400).
     - Response: 202, `Location: /documents/{id}` and `{ documentId, status }`. A replay returns the same answer with the header `Idempotent-Replayed: true`.
   - **`GET /documents?status=&limit=&cursor=`:** limit at most 100.
   - **`GET /documents/{id}`**
   - **`GET /documents/{id}/result`:** `result` only when `Completed`.
   - **`GET /documents/{id}/history`**
2. **Auth guard:**
   - Verify the JWT with jose `createRemoteJWKSet(AUTH_JWKS_URL)`: `iss`, `aud`, `exp`, and an algorithm allowlist (`ES256`).
   - Claims: `sub`, `org_id`, `peppol_id`, `scope`. Route scopes are `documents:submit` and `documents:read`.
   - 401 for a missing or invalid token, 403 for a missing scope. The organisation always comes from the token; another organisation's document is 404.
3. **Problem Details (RFC 9457) via a global exception filter, with a stable `code` catalogue in `shared/problem-details`:**
   - `DocumentRejectedError` → 422 with `errors` (line/column) and `reason`;
   - `NotAPartyError` → 422 `NOT_A_PARTY`;
   - `IdempotencyConflictError` → 409 with `existingDocumentId`;
   - `DocumentNotFoundError` → 404;
   - `DomainError` → 400/422 by code;
   - anything else → 500 with no internals.

   Content type: `application/problem+json`.

4. **Hardening:**
   - helmet; CORS off;
   - `@nestjs/throttler` rate limit keyed by `org_id` (fallback: IP), returning 429 with `Retry-After`;
   - strict validation of path, query and header parameters.
5. **Logging:** nestjs-pino with a correlation ID (`x-correlation-id` in and out; generated when missing), redaction of `authorization`, and no request bodies.
6. **OpenAPI:** `@nestjs/swagger` at `/docs`, plus `/openapi.json` with the bearer security scheme and the Problem Details schema.
7. **`apps/mock-idp`:**
   - `POST /token` (client_credentials; client id/secret via Basic auth or form);
   - clients configured through `MOCK_IDP_CLIENTS` JSON (client → `org_id`, `peppol_id`, scopes);
   - an ES256 key pair generated at startup, `GET /.well-known/jwks.json`, 15 min expiry, `iss`/`aud` from env;
   - small tests.
8. **Tests:** supertest against `ApiModule` with the in-memory adapters and a local JWKS. Cover 202, the replay header, 400/401/403/404/409/413/415/422/429 and an organisation-isolation test.

## Out of scope

Worker, persistence, RabbitMQ, Docker.

## Acceptance criteria

- `pnpm verify` exits 0, with the HTTP tests listed above passing.
- Manual check: run mock-idp + API (in-memory), get a token, POST the fixture invoice, GET its status (show the curl output).
- Only owned paths changed.
- A PR is open (`feat(api): …`).

## /goal condition

```
/goal Work package G05 in docs/goals/G05-http-security.md is done: the endpoints, JWT guard (JWKS, iss/aud/exp, ES256 allowlist, scopes, org scoping, 404 for other orgs), Problem Details filter with code catalogue, 1 MB/415/UTF-8/Idempotency-Key checks, rate limiting, helmet, pino logging with correlation id and redaction, OpenAPI, and the mock IdP exist; supertest tests for 202/replay/400/401/403/404/409/413/415/422/429 pass within `pnpm verify`, which exited 0 (show the tail); you showed a manual curl run (token from mock-idp, POST invoice, GET status) against ADAPTERS=in-memory; `git diff --stat origin/main...HEAD` (shown) touches only the owned paths; and you opened a PR to main with `gh pr create` (show the URL). Follow CLAUDE.md, do not add dependencies. Or stop after 60 turns and report what is missing.
```
