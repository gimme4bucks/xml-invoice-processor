# 0012. Errors as RFC 9457 Problem Details with stable codes; JSON responses

Status: Accepted (2026-11-12)

## Context

Two audiences read our errors:

- Our clients are automated systems, so they have to react to errors programmatically.
- Their developers have to be able to understand what went wrong.

The developer required clear error messages for 4xx responses such as 409. Requests carry XML, and we needed to decide what format to answer in.

## Decision

- **JSON responses** for status, errors and results. The developer's reasoning: this is a Node server, so JSON is the most natural choice.
- **Errors as RFC 9457 Problem Details.** The AI proposed the format.
  - Each error has a stable, machine-readable `code` and a human-readable `detail`.
  - Extra fields are added where they help. Examples:
    - `existingDocumentId` on a duplicate (409, [ADR 0007](0007-idempotency-key-and-content-hash.md));
    - XSD errors with line and column;
    - the official rule IDs taken from the Schematron SVRL output ([ADR 0001](0001-peppol-bis-billing-3-official-rules-saxonjs.md)).
  - Errors never contain internal details such as stack traces or SQL.
- **Language.** Error messages are in English.
- **Status codes in use:**
  - 202 Accepted;
  - 401, 403 and 404 (see [ADR 0008](0008-oauth2-client-credentials-and-organisation-scoping.md));
  - 409;
  - 413 (body larger than 1 MB);
  - 415 (not `application/xml`);
  - 429 with `Retry-After`;
  - 503 (PostgreSQL unavailable).

## Alternatives considered

- **XML responses, mirroring the request format.** The developer considered JSON the more logical choice for a Node service.
- No other error format was evaluated in depth.

## Consequences

- Clients branch on `code`, not on message text, so the wording can improve without breaking them.
- The set of codes is part of the API contract and has to stay stable. It is documented in the OpenAPI description.

## Evidence

n/a

## Follow-ups

- The catalogue of error codes: TODO, to be defined during implementation (work package G05).
