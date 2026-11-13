# G13: Support access with Authorization Code + PKCE

**Goal:** the backend side of the support view. A support employee signs in through the mock IdP
with Authorization Code + PKCE and gets a token with scope `support:read`, which unlocks
**read-only** endpoints across organisations. Every support access is logged. The browser app
itself is the next package (G14).

## Context

Read `CLAUDE.md` (including **Test-driven development**), ADR 0008 (client credentials,
organisation from the token), ADR 0012 (Problem Details) and ADR 0013 (the edge).

The developer chose this design:

- PKCE in the browser, so there is no secret in the frontend.
- Separate support endpoints.
- The API stays a pure resource server: no sessions or cookies.

Today every token must carry `org_id`, and the organisation endpoints are scoped by it. That rule
stays exactly as it is for the organisation endpoints.

G12 (S3) runs at the same time and touches compose, `.env.example`, CI and the README. Keep your
edits to those focused.

## Owned paths

- `apps/mock-idp/**`
- `apps/service/src/shared/auth/**`, `apps/service/src/shared/http/**` (CORS), `apps/service/src/shared/rate-limit/**`, `apps/service/src/shared/problem-details/**` (new codes only)
- `apps/service/src/documents/adapters/inbound/http/**` (a new support controller), `apps/service/src/documents/application/queries/**`
- `apps/service/src/app/**`, `apps/service/src/shared/config.ts`
- **Contract changes, allowed here and to be called out in the PR:**
  - `application/ports/persistence.ts`: one explicitly cross-organisation read method on `DocumentViews`, named so nobody uses it by accident;
  - `test/contracts/**`.
- `apps/service/test/unit/**`, `apps/service/test/contract/**`, `apps/service/test/e2e/support.e2e.spec.ts` (new), `apps/service/test/e2e/support/**` (helpers, additions only)
- `docker-compose.yml`: only the mock IdP's and the API's env; `.env.example`
- `README.md`: the API table and the Security section; `docs/adr/0017-support-access-with-pkce.md` (new)

## Scope

1. **Mock IdP: Authorization Code + PKCE** (RFC 6749 §4.1, RFC 7636, following the OAuth 2.0 Security BCP, RFC 9700):
   - A public client `support-web` with an exact-match allow-list of redirect URIs, set from env (the frontend's origin comes in G14; until then, use a value you choose and document).
   - `GET /authorize` shows a minimal, server-rendered login form for demo support users (from env; compose defaults like the demo clients).
   - Only `response_type=code` and `code_challenge_method=S256`. `state` is required and echoed.
   - Codes are single-use, expire within 60 seconds, and are bound to the client, the redirect URI and the challenge.
   - The token endpoint accepts `grant_type=authorization_code` with `code_verifier` and no secret.
   - The token: `sub` (the support user), `scope: support:read`, the usual `iss`/`aud`/`exp`, and **no** `org_id`.
   - No open redirects: an unknown `redirect_uri` gets an error page, never a redirect.
   - The client-credentials grant keeps working unchanged.
2. **API:**
   - A token without `org_id` never reaches the organisation endpoints: 403 with a stable Problem Details code.
   - A token with `support:read` reaches only the support endpoints:
     - `GET /support/documents`: all organisations, newest first, filters `organisationId`, `status`, `type`, cursor paging;
     - `GET /support/documents/{id}`;
     - `GET /support/documents/{id}/history`.
   - Organisation tokens get 403 there.
   - **Data minimisation:** the support endpoints return metadata, status, failure reasons and history, never the XML or the processing result. Say why in the ADR.
3. **Audit:** every support request logs one JSON line with `sub`, the endpoint, the document id or the filters, and the correlation id. Never content.
4. **CORS:**
   - Off by default.
   - `CORS_ORIGINS` (an exact allow-list) enables it, only for the support endpoints and `GET`, with the `Authorization` header and no credentials.
   - The mock IdP's token endpoint needs CORS for the same origin.
5. **Rate limit:** support tokens are limited per `sub` (there is no organisation).
6. **Docs:**
   - ADR 0017: why PKCE and not client credentials in the browser or a BFF, why separate endpoints and a separate scope, data minimisation, audit, and what a real IdP (MFA, short sessions) adds.
   - OpenAPI.
   - README.

## Test-driven

Red, green, refactor:

- the mock IdP's PKCE rules, one test each: wrong verifier, reused code, expired code, unknown redirect URI, missing state, `plain` method refused;
- the guard's separation of org and support tokens;
- the cross-organisation query in the persistence contract, run against in-memory and Postgres;
- the audit line;
- CORS headers only for allowed origins on support routes;
- an e2e test that runs the whole PKCE flow against the full stack through the edge and then lists documents of both demo organisations.

## Acceptance criteria

- The PR's commits put each red test before its implementation, and **How verified** shows the red and the green runs.
- `pnpm verify` exits 0, and `pnpm test:contract` passes against your own infra.
- CI is green, including e2e with the new support test.
- A PR is open (`feat: support access with Authorization Code + PKCE`).

## Your infrastructure

The worktree's `.env` sets `COMPOSE_PROJECT_NAME=xip-g13` with Postgres on 56432 and RabbitMQ
on 56672/56673. Never start the `full` profile, because G10 owns the default project and the
edge's fixed ports. Your e2e evidence is the PR's CI `e2e` job.

## /goal condition

```
/goal Work package G13 in docs/goals/G13-support-access.md is done: the mock IdP supports Authorization Code + PKCE (S256 only, required state, single-use 60 s codes bound to client, redirect URI and challenge, exact redirect URI allow-list, no open redirect) for a public client support-web, issuing tokens with scope support:read and no org_id; the API keeps org-scoped endpoints closed to tokens without org_id and serves read-only GET /support/documents, /support/documents/{id} and /history across organisations (no XML or result) only for support:read, logging one audit line per request; CORS is off by default and limited to CORS_ORIGINS on support routes; ADR 0017, OpenAPI and the README are updated; you followed red-green-refactor from CLAUDE.md (red tests committed before their implementation, red and green runs shown); `pnpm verify` exited 0 and `pnpm test:contract` passed against your own infra project xip-g13 (show both tails); and you opened a PR to main with `gh pr create` whose CI, including an e2e test of the full PKCE flow, is green (show the URL and `gh pr checks`). Follow CLAUDE.md, do not add npm dependencies. Or stop after 110 turns and report what is missing.
```
