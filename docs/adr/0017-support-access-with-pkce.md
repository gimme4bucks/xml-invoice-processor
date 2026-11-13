# 0017. Support access: Authorization Code + PKCE, separate endpoints and an audit line

Status: Accepted (2026-11-13)

## Context

Until now every caller was an organisation's system with a client-credentials token (ADR 0008).
Every token carried `org_id`, and every query was scoped by it. Support staff need something
else: when an organisation reports a stuck or failed document, a support employee has to look at
that document without being that organisation.

That brings in three new things:

- **a person, not a system**, who signs in from a browser (the support app follows in G14);
- **access across organisations**, which the API has so far made impossible on purpose;
- **an accountability requirement**: who looked at which document, and when.

The developer chose PKCE in the browser (no secret in the frontend), separate support endpoints,
and an API that stays a pure resource server (no sessions or cookies). The organisation rules of
ADR 0008 stay exactly as they are.

## Decision

### Sign-in: Authorization Code with PKCE (mock IdP)

The mock IdP gets a second grant for one **public client, `support-web`**. It follows RFC 6749
§4.1, RFC 7636 and the OAuth 2.0 Security BCP (RFC 9700):

- **`GET /authorize`** checks the client and the redirect URI first, then shows a minimal,
  server-rendered login form for the demo support users (`MOCK_IDP_SUPPORT_USERS`).
- **Exact redirect URIs.** The allow-list (`MOCK_IDP_SUPPORT_REDIRECT_URIS`) is compared as a
  string: no prefixes, no wildcards, no extra query, no other port or scheme.
- **No open redirect.** An unknown client or redirect URI gets an HTML error page and never a
  redirect (RFC 6749 §4.1.2.1). Only once both are known may other errors (a missing `state`,
  `plain`, another `response_type` or scope) go back to the client as `error=…`.
- **Only `response_type=code` and `code_challenge_method=S256`.** `plain` is refused: it gives no
  protection when the authorization request leaks.
- **`state` is required** and echoed, and the response carries `iss` (RFC 9207) against mix-up.
- **Codes** are 32 random bytes, valid for **60 seconds**, and bound to the client, the redirect
  URI and the challenge. **Every redemption attempt burns the code**, so a reused code and a
  wrong verifier both get `invalid_grant`, and a verifier cannot be guessed in several tries.
- **`POST /token`** with `grant_type=authorization_code` takes the `code_verifier` and **no
  secret**. It answers CORS only for the origins of the registered redirect URIs, without
  credentials.
- **The token** has `sub` (the employee), `scope: support:read`, the usual `iss`, `aud`, `exp`
  and `jti`, and **no `org_id` and no `peppol_id`**.
- **The login form** is `no-store`, cannot be framed (`frame-ancestors 'none'`, `X-Frame-Options`),
  runs no scripts (`default-src 'none'`), may only post to itself and be redirected to the client's
  origin (`form-action`), and escapes every reflected value. The redirect after the login is a
  `303`, so the browser never posts the password again.
- **The client-credentials grant is unchanged.**
- The mock IdP logs the client, the subject and the scope of each token, never a password, code,
  verifier or token.

The compose stack registers `https://localhost:5443/callback`, the origin reserved for the support
app of G14, and one demo user, `support-agent`.

### API: two kinds of token, kept apart by `org_id`

The guard now tells two kinds of token apart:

| Token        | Claims                                    | Reaches                                          |
| ------------ | ----------------------------------------- | ------------------------------------------------ |
| Organisation | `sub`, `org_id`, `peppol_id`, `scope`     | `/documents…` with `documents:submit` or `:read` |
| Support      | `sub`, `scope`; no `org_id`, no peppol_id | `/support/documents…` with `support:read`        |

- Each scope belongs to one kind. **A token without `org_id` never reaches an organisation
  endpoint**: `403 ORGANISATION_TOKEN_REQUIRED`. **An organisation token never reaches a support
  endpoint**, even if it claims `support:read`: `403 SUPPORT_TOKEN_REQUIRED`. A support token
  without `support:read` gets `403 INSUFFICIENT_SCOPE`.
- A token with `peppol_id` but without `org_id` is neither kind: `401`, as before.
- The organisation is still taken only from the token. A support token simply has none, so the
  organisation endpoints cannot serve it.

### Separate, read-only support endpoints

- `GET /support/documents`: every organisation, newest first; filters `organisationId`, `status`
  and `type`, cursor paging as in `GET /documents`.
- `GET /support/documents/{id}` and `GET /support/documents/{id}/history`.
- There is nothing that writes, and no `/result` or XML endpoint.
- Persistence gets **one** cross-organisation read, `DocumentViews.listAcrossOrganisations`. Its
  name says what it does, so nobody uses it for an organisation's request by accident. A single
  document is found through its event stream: the first event names the owner, and the read model
  is then read with that organisation as before. No second cross-organisation method was needed.

### Data minimisation

Support responses contain **metadata, status, failure reasons and the event history**, and add
`organisationId`. They **never** contain the original XML or the processing result.

- Support answers "where is my document and why did it fail?". Status, attempts, the failure
  code and message, the violated rule ids and the history answer that.
- The XML and the canonical result contain the invoice's content: parties, VAT numbers, amounts,
  lines and bank details. That is the organisations' business data, often personal data (sole
  traders), and support does not need it. Data that is never returned cannot leak through a
  support laptop, a screenshot or a stolen support token.
- The failure reasons were already written to contain no content (no VAT numbers; see the worker).
- The support query handlers have no access to the `BlobStore` at all, so a later change cannot
  return content by accident without changing the handler's dependencies.

### Audit

Every support request that passed the guard writes **one JSON log line** (`audit:
"support-access"`) with `sub`, the endpoint (`GET /support/documents/:id`), the document id or
the list filters, and the correlation id that every log line of the request carries. It is
written before the handler runs, so a lookup of a document that does not exist is recorded too.
The request's completion line (same correlation id) has the status code. Ids and filters only,
never content or the token.

### CORS, only for the support app

- **Off by default.** `CORS_ORIGINS`, a comma-separated list of exact origins, switches it on.
- **Only on `/support/…`**, only `GET`, only the `Authorization` header, and **no credentials**:
  the app sends a bearer token, never cookies. A preflight from a listed origin is answered before
  authentication (browsers send it without a token); anything else gets no CORS headers.
- The organisation endpoints never answer CORS: their clients are servers.

### Rate limit

Support tokens have no organisation, so they are limited **per `sub`**: one budget per employee,
next to the per-organisation budgets.

## Alternatives considered

- **Client credentials in the browser.** A secret in a single-page app is public: anyone can read
  it from the bundle and get tokens without signing in. It would also identify the app, not the
  employee, so the audit line could not say who looked.
- **A backend for frontend (BFF).** The most secure option for a browser app: tokens stay on a
  server and the browser gets an `HttpOnly` session cookie. But it adds a server with sessions,
  cookies, CSRF protection and a token store, while the API was to stay a pure resource server.
  For an internal support tool with read-only access, short-lived tokens and PKCE are proportionate;
  a BFF is the step up if the support app ever gets write access.
- **Implicit grant.** Deprecated by RFC 9700: the token travels in the URL.
- **The existing endpoints with an extra scope** (for example `documents:read:all`). Every query
  and every handler would need a "skip the organisation filter" branch, which is exactly the kind
  of condition that leaks data when it is wrong. Separate endpoints keep the organisation queries
  unchanged and make every cross-organisation read visible in one controller, one set of handlers
  and one port method.
- **A support token that carries `org_id`** (impersonation). It would look like the organisation
  in every log and event, and it would get the organisation's full access, content included.

## Consequences

- An organisation's API behaves exactly as before. The only visible change for organisation
  clients is the new `ORGANISATION_TOKEN_REQUIRED` code for a token without `org_id`, which they
  never receive from their own IdP client.
- The support app (G14) only needs the IdP's `/authorize` and `/token`, and the API's
  `/support` endpoints with CORS for its origin.
- The cross-organisation list sorts `document_views` by `received_at` without an organisation.
  The existing index starts with `organisation_id`; at a large scale, an index on
  `(received_at DESC, document_id DESC)` would be added in a new migration.
- The audit lines are only as durable as the log pipeline. In production they go to an
  append-only log store with its own retention.

## What a real IdP adds

The mock IdP shows the protocol, not the identity management. With Entra ID, Okta or Keycloak,
the API changes only its configuration (ADR 0008), and the IdP adds:

- **MFA**, ideally phishing-resistant (FIDO2/passkeys), and conditional access (managed devices,
  known networks);
- **short sessions**: short access tokens (5–15 minutes), refresh tokens with rotation and reuse
  detection, an idle timeout, and sign-out;
- **joiners, movers and leavers**: employees come from the company directory, and access ends on
  the day someone leaves;
- **group- or role-based scopes**, so only the support team gets `support:read`;
- **its own audit** of sign-ins and failed attempts, lockout and brute-force protection;
- revocation of all tokens issued from a reused code (RFC 6749 §4.1.2), which a stateless mock
  cannot do for JWTs.

## Evidence

- Mock IdP: `apps/mock-idp/src/authorization-code.spec.ts`, one test per PKCE rule.
- API: `test/unit/support-api.spec.ts` (separation of tokens, endpoints, filters, data
  minimisation, rate limit per `sub`), `test/unit/support-audit.spec.ts`,
  `test/unit/support-cors.spec.ts`.
- Persistence: the cross-organisation list in the persistence contract, against in-memory and
  Postgres.
- End to end: `test/e2e/support.e2e.spec.ts` runs the whole PKCE flow through the HTTPS edge and
  lists the documents of both demo organisations.

## Follow-ups

- The support app (G14).
- A durable audit store, and alerting on unusual support access (volume, hours).
- Break-glass access to content, if support ever needs it: a separate scope, a reason, and a
  second person's approval.
