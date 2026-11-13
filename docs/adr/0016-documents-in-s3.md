# 0016. Documents in S3 behind the BlobStore port

Status: Accepted (2026-11-13). Carries out the follow-up of [ADR 0011](0011-document-storage-in-postgresql-behind-blobstore-port.md).

## Context

ADR 0011 stores every document in PostgreSQL, in the same transaction as its event, and plans S3
as a later step: write the object first under a content-addressed key, then commit the
transaction that references it, and clean up objects that never got referenced.

Why now: at the assumed 1,000 documents a day of at most 1 MiB, Postgres grows by up to 1 GB a
day, and fiscal retention is 7 years. Backups, restores and vacuum all carry the documents along.
An object store is the usual place for them.

What must not change:

- **An accepted document is never lost.** The client gets `202` only after the commit, and a
  committed document must be readable.
- **Storing never half-succeeds** in a way anyone can see.
- **The `BlobStore` port.** `put(blob, tx)` runs inside `UnitOfWork.run`, at intake (the original
  XML) and in the worker (the result); `get(key)` reads them. The port did not change; only an
  adapter was added.

The object store sits outside the database transaction, so this is a dual write again (ADR 0003,
ADR 0011). The decision is how to order it so that every failure is harmless.

## Decision

`BLOB_STORE=s3` binds `S3BlobStore`: the bytes in a bucket, the reference in the `blobs` table.
`BLOB_STORE=postgres` (the default) keeps ADR 0011's behaviour.

### Write order

`S3BlobStore.put(blob, tx)`, inside the caller's unit of work:

1. **Hold the hash.** `pg_advisory_xact_lock_shared(hashtextextended(sha256, 0))` in the unit of
   work's transaction. Writers share it; it keeps the orphan collector away (below) until the
   transaction ends.
2. **Upload the object** under `sha256/<hex>` with `x-amz-checksum-sha256`. The server recomputes
   the checksum and refuses a damaged upload (`BadDigest`).
3. **Record the reference** in the same transaction: a `blobs` row with the key, content type and
   sha256, and no content.
4. The unit of work **commits**: event, read model, reference, outbox row and idempotency record
   together.

**Why it is safe:** the upload has finished before the reference can commit, so a committed
reference always points at a complete object. Every failure before the commit leaves at most an
object without a reference, which nobody can reach and which is deleted later. No failure leaves
a reference without an object.

**Content addressing** makes repeats harmless. A client's retry, a redelivery in the worker, or the
supplier and the customer submitting the same file all write the same bytes to the same name. The
name also proves the bytes: `get` resolves the reference, downloads the object and compares its
sha256. A mismatch or a missing object is an error, never "not found" and never wrong bytes.
`get` returns `undefined` only for a key that has no committed reference.

The Postgres and in-memory stores now check the sha256 on read too. The `BlobStore` contract tests
run against all three: round trip, a rolled-back put, the same content twice, and a sha256
mismatch.

### Failure handling

- **Deadline.** Every S3 call has a deadline of `S3_TIMEOUT_MS` (3 s), including connecting. The
  upload runs inside a database transaction (timeout 5 s), so it must give up first.
- **No retries in the SDK** (`maxAttempts: 1`). The caller retries, like with the Postgres adapter:
  the API client with the same `Idempotency-Key`, the worker by requeueing.
- **Unreachable, timed out or 5xx** becomes `PersistenceUnavailableError`. The API answers `503`
  with `Retry-After`; the worker requeues with backoff (ADR 0014 covers longer outages).
- **Everything else passes through unchanged.** `AccessDenied` or `NoSuchBucket` is a configuration
  mistake and must be loud.
- Logs carry keys, hashes and error codes only, never content.

| Failure                                          | What happens                                                                                                                                                                                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Object store down at intake                      | `503` within about 3 s; nothing commits. The client retries with the same key.                                                                                                                                                     |
| Object store down in the worker                  | Reading the original or writing the result fails; the message is requeued with backoff. After 10 deliveries it is dead-lettered, and the redrive or the sweeper sends the document back (ADR 0014).                                |
| Upload landed, but its answer was lost (timeout) | Treated as down: the unit of work rolls back and the object is an orphan. The retry writes the same object again and references it.                                                                                                |
| Process dies between the upload and the commit   | Postgres rolls the transaction back and releases the hold. The object is an orphan.                                                                                                                                                |
| The commit's outcome is unknown                  | Either the reference committed (the object is there) or it did not (an orphan). Both are safe, and the retry with the same key settles it.                                                                                         |
| Upload damaged on the way                        | The server refuses it (`BadDigest`); the unit of work rolls back.                                                                                                                                                                  |
| Object deleted or changed behind our back        | `get` throws (missing, or sha256 mismatch) and never serves it. The API answers `500` for the result; the worker's message ends in the DLQ. Restore the object from versioning or a backup; its name tells which bytes are needed. |

### Orphans: a reconciliation with locks

Each worker runs `OrphanSweepLoop`, hourly by default (`S3_ORPHAN_SWEEP_INTERVAL_MS`). It lists the
bucket and, for every object written more than `S3_ORPHAN_MIN_AGE_MS` (an hour) ago, does this in
one database transaction:

1. **Try the exclusive lock:** `pg_try_advisory_xact_lock` on the same key. If a writer holds the
   hash, skip the object.
2. If no `blobs` row has that sha256, **delete the object while holding the lock**.

| Situation                                                      | Outcome                                                                                                    |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| A writer has uploaded but not committed                        | It holds the shared lock, so the collector skips the object.                                               |
| A writer has committed                                         | The reference exists, so the collector keeps the object.                                                   |
| The writer rolled back or died                                 | Postgres released its lock and no reference exists, so the object is deleted.                              |
| A writer of the same bytes arrives while the collector deletes | It waits for its shared lock until the collector commits, then uploads the object again and references it. |
| Two workers collect at once                                    | One gets the lock; deleting an object that is already gone is not an error.                                |

**Why the lock and not just the age.** A retry can upload bytes identical to an old orphan, which
rewrites the same name, between the collector's "no reference" check and its delete. That retry
would then commit a reference to a deleted object. An age check cannot close that window; the lock
can. The age only keeps the collector away from objects in active use.

**Why not a lifecycle rule.** A rule expires objects by prefix, tag and age; it cannot know whether
a `blobs` row references the object. Making it work needs a step after the commit (re-tag, or move
from `pending/` to `committed/`). That step is itself a dual write that can fail after the commit,
and the referenced object would then expire: the one loss we must rule out. Versity S3 Gateway,
the local server, does not implement lifecycle configuration anyway (`NotImplemented`). The
reconciliation behaves the same on AWS and locally, and the tests cover it against both.

**Its cost.** Listing is linear in the number of objects. At this volume that is about 5 million
objects after 7 years, or 5,000 list pages per run: fine once a day, wasteful once an hour. At that
size, read an S3 Inventory report instead of listing. That is an open point, not built.

### Configuration

| Variable                                              | Meaning                                                                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BLOB_STORE`                                          | `postgres` (default, and what `pnpm infra:up` development uses) or `s3` (the full compose stack). Anything else stops startup.                    |
| `S3_BUCKET`, `S3_REGION`                              | Required with `s3`.                                                                                                                               |
| `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE`                  | Only for a local S3-compatible server.                                                                                                            |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`            | Only the local server's demo keys, kept in compose like the other demo secrets. Unset in a deployment: the SDK's default chain uses the IAM role. |
| `S3_TIMEOUT_MS`                                       | The deadline per call (3 s).                                                                                                                      |
| `S3_ORPHAN_SWEEP_INTERVAL_MS`, `S3_ORPHAN_MIN_AGE_MS` | The collector (an hour each).                                                                                                                     |

A new migration makes `blobs.content` nullable and indexes `blobs.sha256`, so one table serves
both modes. Postgres stays the development default because it needs nothing extra, and its
behaviour is the one ADR 0011 describes. The full stack, the demo and the e2e tests run on S3.

Switching an existing database from `postgres` to `s3` does not move its rows. Their bytes stay in
`content`, and `S3BlobStore` would report their objects missing; a one-off copy (upload, then clear
`content`) would be needed, and is not built. The other way round, `PrismaBlobStore` refuses a
reference row with a clear error.

### Local server: Versity S3 Gateway v1.10.0

| Candidate              | Assessment (2026-11)                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MinIO                  | Stopped publishing community images and binaries in October 2025; the repository was archived in April 2026. Out.                                                                                                                                                                                                                                                               |
| **Versity S3 Gateway** | **Chosen.** Maintained by Versity with monthly releases, Apache-2.0, and a single Go binary in an Alpine image of about 37 MB that idles at about 11 MiB here. It has a health endpoint (`VGW_HEALTH`) and verifies `x-amz-checksum-*`. Its posix backend shows a directory as a bucket, so the bucket setup is a `mkdir`. No lifecycle rules, which this design does not need. |
| SeaweedFS              | Maintained and capable, but it runs a master, volume servers and a filer for what we use as one bucket. More memory and moving parts than this needs.                                                                                                                                                                                                                           |
| Garage                 | Light, but a fresh node needs a layout and keys set up through its CLI before the first request, and the image has no shell for a one-shot setup.                                                                                                                                                                                                                               |
| RustFS                 | A MinIO look-alike, but 1.0 only since October 2026, so its maturity is still open.                                                                                                                                                                                                                                                                                             |
| LocalStack             | Emulates far more than S3, and needs far more memory.                                                                                                                                                                                                                                                                                                                           |

The image is pinned to `versity/versitygw:v1.10.0`, released 2026-10-22. That is at least two weeks
old, the same rule as our dependencies; v1.11.0 from 2026-11-06 was too new. It runs in both
compose profiles and as a service container in CI's contract job.

### Production

- **Encryption at rest:** SSE-KMS with a customer-managed key as the bucket's default encryption,
  with S3 Bucket Keys to keep KMS calls down. The service's IAM role may use that key and that
  bucket only. A bucket policy refuses requests without TLS (`aws:SecureTransport`). Block Public
  Access stays on.
- **Retention of 7 years:** deletion goes through the database. When a document's retention ends,
  its rows go, and the collector deletes objects that lost their last reference. An expiration
  rule would not know that a newer document may reference the same bytes.
- **Object Lock (an option)** in compliance mode, with a default retention of 7 years, when
  auditors require WORM storage. It needs versioning. Its cost here: the collector's delete only
  adds a delete marker, so orphans (failed transactions only) are kept until their retention ends.
  Governance mode would let a privileged role remove them.
- **Without Object Lock:** versioning, with a lifecycle rule on noncurrent versions, protects
  against accidental deletes. A lifecycle rule that aborts incomplete multipart uploads costs
  nothing (we upload in one part, at most 1 MiB).
- **Names hold no personal data:** an object is named by a hash, never by an organisation or
  document id.
- **Backups:** objects are immutable and named by content. A bucket that is newer than the
  database after a restore only holds extra orphans; restoring the database to a point after the
  bucket's state is what must be avoided.

## Alternatives considered

- **A lifecycle rule on a `pending/` prefix or a tag.** See above: it needs a step after the commit
  that can fail and then lose a referenced object, and the local server has no lifecycle support.
- **Moving the bytes to S3 later through the outbox** (an idea from the README's next steps).
  Postgres would still receive every byte first, which is what this ADR wants to avoid, and a
  reader would have to look in two places.
- **Uploading before the unit of work opens,** in the command handlers. That would free the
  database connection during the upload, but changes the application layer and the port, and the
  hold would need a transaction of its own. Worth it only if connection pressure shows up.
- **A random object name per upload.** It makes the locks unnecessary, because an orphan's name is
  never written again. But it loses deduplication, the name that proves the bytes, and the
  idempotent re-upload on a retry. The locks are a few lines of SQL.

## Consequences

- Postgres no longer grows with the documents: a reference row is about 200 bytes.
- A dual write remains, but it is ordered so that its only failure is an unreferenced object. That
  costs storage until the next collection.
- The transaction holds its database connection during the upload, at most `S3_TIMEOUT_MS`. With a
  slow object store the pool can run out, and the API answers `503`, which it would anyway.
- Two systems must be backed up and kept consistent (see Production).
- The worker gains a periodic job that lists the bucket: fine at this scale, and an S3 Inventory
  report later.

## Evidence

- `apps/service/test/unit/s3-blob-store.spec.ts`: the write order and deterministic faults (the
  upload fails, the transaction fails after it, its answer is lost, the process dies before the
  commit), and the collector.
- `apps/service/src/documents/adapters/outbound/s3/s3-object-store.spec.ts`: the SDK against fake
  servers (refused, frozen, 503, 403, 404, checksum header).
- `apps/service/test/contract/s3.contract.spec.ts`: the `BlobStore` contract and the advisory locks
  against Versity S3 Gateway and Postgres.
- `apps/service/test/e2e/outages.e2e.spec.ts`: the gateway paused in the full stack: `503`, then one
  document after the retry.
