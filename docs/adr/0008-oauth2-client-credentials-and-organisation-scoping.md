# 0008. Authentication and authorisation: OAuth2 client credentials and organisation scoping

Status: Accepted (2026-11-12)

## Context

Our clients are other organisations' systems. They are fully automated, with no human users, and we expect fewer than 10,000 organisations. So we need:

- machine-to-machine authentication;
- authorisation per organisation;
- a way to work without a real identity provider, since none is available for this concept.

The developer also required that purchase invoices be told apart from sales invoices. As the AI pointed out, that is the submitting organisation's point of view, not a property of the document.

## Decision

- **OAuth2 client credentials, with JWTs from a mock IdP.**
  - The mock IdP is a small app of its own (`apps/mock-idp`, about 80 lines).
  - `/token` exchanges a `client_id` and secret for a JWT that is valid for 15 minutes.
  - JWKS are served at `/.well-known/jwks.json`.
  - The signing keys are generated at startup.
  - Moving to Cognito, Entra or Keycloak is a configuration change: another URL.
- **Token checks:**
  - the signature, via JWKS;
  - `iss`, `aud` and `exp`;
  - an algorithm allowlist, so no `alg: none` and no algorithm confusion.
- **Claims:** `sub` (the client), `org_id`, `peppol_id`, `scope`.
- **Scopes:** `documents:submit` to submit, `documents:read` to read.
- **Organisation scoping from token claims only.** Every query filters on the `org_id` from the token, never on a value taken from the URL or the body.
- **404 for other organisations' documents**, not 403, so the API does not reveal that the document exists.
- **Purchase vs sales from the token's Peppol ID.**
  - If `peppol_id` matches the supplier's `EndpointID`, it is a sales invoice. If it matches the customer's `EndpointID`, it is a purchase invoice. If it matches neither, the document is rejected.
  - The kind decides whose VAT number goes to VIES (purchase → supplier, sales → customer), with one strategy per kind.
- **Rate limit per organisation:** 429 with `Retry-After`.

## Alternatives considered

- **Keycloak in Docker Compose.** A real IdP, but it needs 0.5–1 GB of RAM, which did not fit the memory budget of the local container setup.
- **API keys.** They live long, are hard to rotate, and have no standard way to express scopes.
- **Purchase vs sales as a separate field in the request.** Dropped in favour of deriving it from the token.

## Consequences

- Swapping the IdP is a configuration change.
- An organisation's token must carry its Peppol ID for the purchase/sales check to work.
- E2E tests cover 401 (no token or an invalid one), 403 (a missing scope) and 404 (another organisation's document).
- The rate limit is per instance for now. Production needs a shared one (Redis).

## Evidence

n/a

## Follow-ups

- A real IdP (configuration only).
- Possibly mTLS for B2B clients.
- A shared rate limit.
- Individual people as users, later.
- Webhooks or callbacks instead of polling.
