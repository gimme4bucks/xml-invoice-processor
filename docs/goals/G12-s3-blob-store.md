# G12: Documents in S3 behind the BlobStore port

**Goal:** an S3 adapter for the `BlobStore` port, used by the full compose stack with a local
S3-compatible server, without weakening the guarantee that an accepted document is never lost.

## Context

Read `CLAUDE.md` (including **Test-driven development**), ADR 0003, ADR 0004 and above all
ADR 0011 and its follow-up:

- Write the object first, under a content-addressed key.
- Then commit the database transaction that references it.
- Objects that never got referenced are cleaned up.

The `BlobStore` port is called inside `UnitOfWork.run` (the original XML at intake, the result
in the worker). Today the Postgres adapter writes the bytes into the `blobs` table in that
transaction. `@aws-sdk/client-s3` 3.1165.0 is installed for you; add no other dependencies.

G10 (chaos tests) and G13 (support access) run at the same time. Keep your edits to shared files
(`docker-compose.yml`, `.env.example`, `ci.yml`, README) focused.

## Owned paths

- `apps/service/src/documents/adapters/outbound/s3/**` (new), `apps/service/src/app/**` (the binding and config)
- `apps/service/test/contract/**`, `apps/service/test/unit/**`
- **Contract changes, allowed here and to be called out in the PR:**
  - `test/contracts/**` (BlobStore cases);
  - `prisma/schema.prisma` plus a **new** migration, if the `blobs` table must hold a reference instead of the bytes;
  - `application/ports/persistence.ts` (only if the BlobStore port must change; prefer not to).
- `docker-compose.yml`: an object store service in both profiles, with its one-shot bucket setup if needed, and the env for the services
- `.env.example`
- `.github/workflows/ci.yml`: only the `contract` and `e2e` jobs, if they need the object store
- `apps/service/test/e2e/outages.e2e.spec.ts` (an object store outage)
- `README.md`: Architecture, Reliability and the decisions table; `docs/adr/0016-documents-in-s3.md` (new); ADR 0011 (a status line pointing to 0016)

## Scope

1. **`S3BlobStore`:**
   - `put` uploads the object under a content-addressed key (sha256 of the bytes) **before** the surrounding transaction commits, and records the reference in that same transaction.
   - `get` resolves the reference, downloads the object and verifies its sha256.
   - The same content uploaded twice is harmless.
   - S3 errors that mean "unreachable or timed out" map to `PersistenceUnavailableError` (the API answers 503 with `Retry-After`; the worker requeues), with a timeout like the Postgres adapter's.
   - Never log content.
2. **Orphans:**
   - An object whose transaction rolled back, or whose process crashed before the commit, must not be referenced, and must eventually go away.
   - Choose and justify the mechanism (a lifecycle rule on a prefix or tag, or a reconciliation command), and say what the local server supports.
3. **Configuration:**
   - `BLOB_STORE=postgres|s3`. The Postgres adapter stays and stays the default for `pnpm infra:up` development, unless you justify otherwise.
   - The full compose stack uses S3.
   - Bucket, endpoint, region and credentials come from env. The demo credentials live in compose only, like the other demo secrets.
4. **Local S3 server:**
   - Pick one that is maintained, has a pinned image at least two weeks old, is light on memory (Colima has 2 GB) and has a healthcheck.
   - Note that MinIO stopped publishing community images in late 2025; check the current state. Justify the choice in the ADR.
5. **Docs:**
   - ADR 0016: the write order, why it is safe, orphan handling, failure modes, encryption at rest and retention in production (SSE-KMS, 7-year retention, Object Lock as an option).
   - README: Architecture, a Reliability row for "object store down", and the decisions table.

## Test-driven

Red, green, refactor:

- the BlobStore contract cases run against in-memory, Postgres and S3: round trip, idempotent re-put, sha256 mismatch detected, missing object;
- unit tests for the write order with deterministic fault injection: the S3 put fails, the transaction fails after the put, a crash between the two;
- an e2e outage test (the object store paused): 503, then a retry with the same key gives one document.

## Acceptance criteria

- The PR's commits put each red test before its implementation, and **How verified** shows the red and the green runs.
- `pnpm verify` exits 0, and `pnpm test:contract` passes against your own infra, including the object store.
- CI is green: contract and e2e on the full stack with S3.
- A PR is open (`feat: S3 adapter for the BlobStore port`).

## Your infrastructure

The worktree's `.env` sets `COMPOSE_PROJECT_NAME=xip-g12` with Postgres on 55432 and RabbitMQ
on 55672/55673. Choose free ports for the object store, starting at 59000. Never start the
`full` profile, because G10 owns the default project and the edge's fixed ports. Your e2e
evidence is the PR's CI `e2e` job.

## /goal condition

```
/goal Work package G12 in docs/goals/G12-s3-blob-store.md is done: an S3BlobStore writes each object under a content-addressed key before the transaction that references it commits, verifies sha256 on read, maps unreachable/timeouts to PersistenceUnavailableError, and orphans are handled by a justified mechanism; BLOB_STORE selects postgres or s3 and the full compose stack uses a maintained, pinned local S3 server; the BlobStore contract passes against in-memory, Postgres and S3, and an e2e test covers an object store outage (503, then one document on retry); ADR 0016 and the README are updated; you followed red-green-refactor from CLAUDE.md (red tests committed before their implementation, red and green runs shown); `pnpm verify` exited 0 and `pnpm test:contract` passed against your own infra project xip-g12 (show both tails); and you opened a PR to main with `gh pr create` whose CI is green (show the URL and `gh pr checks`). Follow CLAUDE.md, add no dependencies beyond @aws-sdk/client-s3. Or stop after 100 turns and report what is missing.
```
