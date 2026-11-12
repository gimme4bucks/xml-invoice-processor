# G03: Persistence (Prisma / PostgreSQL)

**Goal:** real Postgres adapters for every persistence port that pass the same contract suite as
the in-memory adapters.

## Context

- Read `CLAUDE.md`, ADRs 0003, 0004, 0007, 0009, 0011.
- The schema and the init migration exist: `apps/service/prisma/`. The events table is append-only by trigger.
- The contract: `apps/service/test/contracts/persistence.contract.ts`. It already passes for the in-memory adapters.

## Owned paths

- `apps/service/src/documents/adapters/outbound/postgres/**` (new)
- `apps/service/test/contract/postgres.contract.spec.ts` (new)
- `apps/service/prisma/migrations/**`: new migrations only; never edit `20261112000000_init`

## Scope

1. **`PrismaService`:**
   - one `PrismaClient` per process, using `@prisma/adapter-pg` with `DATABASE_URL`;
   - connects on bootstrap and disconnects on shutdown;
   - import the client from `src/generated/prisma/client`.
2. **`PrismaUnitOfWork`:** an interactive transaction. The `Transaction` handle is the Prisma transaction client; every adapter casts it back.
3. **Adapters:**
   - **`PrismaEventStore`:** append with the expected-version check; unique violation `P2002` on `(stream_id, version)` becomes `ConcurrencyError`.
   - **`PrismaDocumentViews`:** upsert. `list` uses keyset pagination on `(received_at DESC, document_id DESC)` with an opaque cursor.
   - **`PrismaBlobStore`:** stores sha256 next to the content.
   - **`PrismaOutbox`:** `publishPending` uses `SELECT … FOR UPDATE SKIP LOCKED` (`$queryRaw`) inside a transaction, marks `published_at` only after `publish` resolved, and on failure increments `attempts` and stores `last_error`. Keep the transaction short.
   - **`PrismaIdempotencyRegistry`:** select, then insert. A `P2002` from a concurrent request becomes `IdempotencyRaceError`.
4. **Export `postgresProviders(): Provider[]`** binding all persistence ports plus `PrismaService`. G07 plugs it into `src/app/adapters.ts`; do not edit that file.
5. **`test/contract/postgres.contract.spec.ts`:** runs `describePersistenceContract('postgres', …)`.
   - Isolate with a fresh schema per run: `DATABASE_URL` + `?schema=contract_<random>`, run `prisma migrate deploy` for that schema, and drop the schema afterwards.
   - `reset()` empties the tables. Events need `SET session_replication_role = replica` in test code only, or recreate the schema.
6. **Optional, if time allows:** a least-privilege runtime role (INSERT/SELECT on events, no UPDATE/DELETE) as a new migration plus a note for compose. Otherwise list it under Open points.

## Out of scope

Composition root, RabbitMQ, HTTP, changing the schema of existing tables (propose instead).

## Acceptance criteria

- With `pnpm infra:up` running, `pnpm test:contract` passes the full persistence contract against Postgres (show the output).
- `pnpm verify` exits 0.
- Only owned paths changed.
- A PR is open (`feat(persistence): …`).

## /goal condition

```
/goal Work package G03 in docs/goals/G03-persistence.md is done: Prisma adapters for UnitOfWork, EventStore, DocumentViews, BlobStore, Outbox (FOR UPDATE SKIP LOCKED) and IdempotencyRegistry exist under adapters/outbound/postgres with an exported postgresProviders(); with infra up you ran `pnpm test:contract` and the output shows the persistence contract passing against Postgres (show it); you ran `pnpm verify` and it exited 0 (show the tail); `git diff --stat origin/main...HEAD` (shown) touches only the owned paths; and you opened a PR to main with `gh pr create` (show the URL). Follow CLAUDE.md, never run `prisma migrate reset`, do not add dependencies. Or stop after 60 turns and report what is missing.
```
