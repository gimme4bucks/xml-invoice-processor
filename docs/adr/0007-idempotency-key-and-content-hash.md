# 0007. Idempotency: Idempotency-Key header plus content hash

Status: Accepted (2026-11-12)

## Context

The developer's requirement is that an invoice must never be processed twice. Our clients are automated systems, and they retry: after a timeout, for example, or after a 503 when PostgreSQL is down ([ADR 0004](0004-transactional-outbox-and-idempotent-consumer.md)).

## Decision

- **The key.** The `Idempotency-Key` header is mandatory on submission and is scoped per organisation.
  - The same key with the same content (compared by SHA-256 of the body) returns the original response with the same document ID.
  - The same key with different content returns 409 Conflict.
  - Keys are kept indefinitely, given the assumed volume of 1,000 documents per day.
  - A unique index resolves races between concurrent requests.
  - The key is stored in the same transaction as the document ([ADR 0003](0003-event-sourcing-in-postgresql.md)).
- **Content hash across keys** (the developer's idea, added to the AI's key-based proposal).
  - A byte-identical file from the same organisation is recognised even under a new key.
  - It is rejected with 409 and a reference to the existing document (`existingDocumentId`, [ADR 0012](0012-problem-details-and-json-responses.md)).
- **Accepted risk.** The same invoice with different formatting has different bytes, so it gets through.
- **The business-level duplicate check** (invoice number unique per organisation) is **deferred**. See below.

## Alternatives considered

- **A key-based check only, with no hash check** (the AI's original proposal). A resubmitted file with a fresh key would be processed twice.
- **A business-level duplicate check on invoice number, right away** (also proposed by the AI). We deferred it, for these reasons from the developer:
  - In production, customers send these fields in different ways ("ref", "invoice ref", "fac nummer"), so a field mapping has to come first.
  - The schema we validate against is our own choice, not necessarily what production receives.
  - Building that mapping layer takes time and means making assumptions about a part of the system nobody asked for.
  - Within our own schema it would just be a unique index. It was left out to keep the scope down, not because it is hard.
  - In production, with several formats (UBL/Peppol, SI-UBL in the Netherlands), an anti-corruption layer to a canonical domain model has to come first. Only then does a business-level duplicate check make sense.
  - Credit notes and corrections make the rule less simple.

## Consequences

- Clients must send an `Idempotency-Key`, and a retry with the same key is always safe.
- Two different situations both produce a 409: a key reused with other content, and a known file sent under a new key. The Problem Details codes that tell them apart: TODO.
- Tests cover:
  - In e2e:
    - the same key returns the same ID;
    - the same key with different content returns 409;
    - the same file with a new key returns 409.
  - In a contract test against the real database: concurrent requests with the same key create exactly one document.

## Evidence

n/a

## Follow-ups

- A business-level duplicate check, after an anti-corruption layer to a canonical model.
- Rules for credit notes and corrections.
