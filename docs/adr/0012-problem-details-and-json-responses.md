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

- The catalogue of error codes, settled during implementation (work packages G05 and G07). The source of truth is `apps/service/src/shared/problem-details/problem-codes.ts`, which also feeds the OpenAPI description. Codes are only ever added, never renamed or reused.

| Status | `code`                   | Meaning                                                                                                                                                                                                    |
| ------ | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `INVALID_REQUEST`        | A path, query or header parameter is missing or invalid; see `errors`.                                                                                                                                     |
| 401    | `UNAUTHENTICATED`        | The bearer token is missing, malformed, expired or not issued for this API.                                                                                                                                |
| 403    | `INSUFFICIENT_SCOPE`     | The token is valid but lacks the scope this operation requires.                                                                                                                                            |
| 404    | `DOCUMENT_NOT_FOUND`     | No document with this id exists for your organisation.                                                                                                                                                     |
| 404    | `NOT_FOUND`              | No such route.                                                                                                                                                                                             |
| 409    | `IDEMPOTENCY_KEY_REUSED` | The Idempotency-Key was already used for a document with different content; see `existingDocumentId`.                                                                                                      |
| 409    | `DUPLICATE_DOCUMENT`     | This exact file was already submitted under another Idempotency-Key; see `existingDocumentId`.                                                                                                             |
| 413    | `PAYLOAD_TOO_LARGE`      | The request body exceeds the maximum document size.                                                                                                                                                        |
| 415    | `UNSUPPORTED_MEDIA_TYPE` | Send the document as `Content-Type: application/xml` without a Content-Encoding.                                                                                                                           |
| 415    | `UNSUPPORTED_CHARSET`    | Only UTF-8 is accepted (Content-Type charset, XML declaration and bytes).                                                                                                                                  |
| 422    | `DOCUMENT_REJECTED`      | The document failed the structural checks (well-formedness, DOCTYPE ban, document type, UBL 2.1 XSD); see `reason` and `errors`.                                                                           |
| 422    | `NOT_A_PARTY`            | Your organisation's Peppol id is neither the supplier's nor the customer's EndpointID.                                                                                                                     |
| 422    | `INVALID_PEPPOL_ID`      | An EndpointID in the invoice is not a valid Peppol participant id (`0000:value`).                                                                                                                          |
| 422    | `MISSING_ENDPOINT_ID`    | The supplier or customer has no `cbc:EndpointID` with a `schemeID` (Peppol participant id).                                                                                                                |
| 429    | `RATE_LIMITED`           | Rate limit for your organisation exceeded; retry after `Retry-After` seconds.                                                                                                                              |
| 500    | `INTERNAL_ERROR`         | Something went wrong on our side. Quote the correlation id when reporting it.                                                                                                                              |
| 503    | `AUTH_UNAVAILABLE`       | The identity provider's signing keys could not be fetched; retry later.                                                                                                                                    |
| 503    | `SERVICE_UNAVAILABLE`    | A backing service (the database) is temporarily unavailable. The document may or may not have been stored: retry after `Retry-After` seconds with the same Idempotency-Key and body, which is always safe. |

A `DomainError` keeps its own code only when that code is in the catalogue; any other domain error guards an invariant, so it is our bug and becomes `500 INTERNAL_ERROR`. Every response also carries the request's `correlationId`.
