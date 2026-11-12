# 0011. Document storage in PostgreSQL behind a BlobStore port

Status: Accepted (2026-11-12)

## Context

Every accepted XML document must be stored durably before we answer 202 ([ADR 0004](0004-transactional-outbox-and-idempotent-consumer.md)). That includes documents that later fail rule validation. The developer's requirement is that storing must never half-succeed.

Size and volume:

- Documents are at most 1 MB each.
- Embedded attachments are out of scope.
- The assumed volume is 1,000 documents per day.

## Decision

- We store the XML in PostgreSQL, behind a `BlobStore` port.
- It is written in the same transaction as the event, the status row, the outbox row and the idempotency key ([ADR 0003](0003-event-sourcing-in-postgresql.md)). So storing a document is atomic.
- Documents that fail rule validation stay stored, together with the reason.

## Alternatives considered

- **S3 (MinIO locally) right away.** S3 is the natural place for documents at scale, but object storage sits outside the database transaction. Writing to both S3 and PostgreSQL is a dual write again, which we would have to handle explicitly. This is the same reason that weighs against a separate event store in ADR 0003. So S3 is planned as a later step instead.

## Consequences

- Storage is atomic, with no dual write.
- The database grows with the documents. At the assumed volume and maximum size, the upper bound is about 1 GB per day.
- The `BlobStore` port keeps a later move to S3 confined to an adapter. The transaction boundary, however, changes with it.
- These are production topics, covered in the README:
  - the 7-year fiscal retention requirement and a deletion policy;
  - encryption at rest (RDS, S3 KMS).

## Evidence

n/a

## Follow-ups

- An S3/MinIO adapter for the `BlobStore` port, as weekend work and as a step towards production scale.
  - Dual write with S3: write the object first under a content-addressed key, then commit the database transaction that references it; objects that never got referenced are cleaned up by an S3 lifecycle rule.
- Embedded attachments, together with S3.
