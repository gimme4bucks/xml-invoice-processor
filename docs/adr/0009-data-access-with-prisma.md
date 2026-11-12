# 0009. Data access with Prisma

Status: Accepted (2026-11-12)

## Context

The outbound persistence adapters need access to PostgreSQL. These are the event store, the read model, the outbox, the idempotency keys and the blob store. The other ADRs add these requirements:

- one transaction spanning several adapters;
- `FOR UPDATE SKIP LOCKED` for the relay;
- database roles and an append-only event table;
- unique-index violations used as signals for concurrency conflicts and idempotency hits.

## Decision

We use **Prisma**. The developer chose it as the easiest, fastest and most familiar option; the AI had recommended Kysely, with Drizzle as an alternative.

- **Versions.** `prisma`, `@prisma/client` and `@prisma/adapter-pg` are pinned exactly on 7.10.1.
- **Raw SQL** where Prisma has no API:
  - `$queryRaw` or TypedSQL for `FOR UPDATE SKIP LOCKED`;
  - hand-written SQL in migrations created with `--create-only`, for roles, privileges and the append-only event table.
- **One interactive transaction.** `$transaction(async tx => …)` covers the event, status row, outbox row, idempotency key and XML. Adapters receive the transaction client and pass it along (a transaction context, or unit of work).
- **Error mapping.** Unique-index violations (`P2002`) are mapped to a concurrency conflict or an idempotency hit.
- **Type boundary.** Prisma types stay inside the outbound adapters and are mapped to domain objects. A lint rule enforces this.

## Alternatives considered

- **Kysely** (the AI's recommendation). The developer chose Prisma for familiarity and speed of delivery.
- **Drizzle.** Mentioned by the AI as another alternative.

## Consequences

- A fast start with a familiar tool. The parts that need precise SQL use raw SQL.
- **Version-pinning pitfall.** On 2026-11-12, the npm `latest` dist-tag for `prisma` pointed at 8.0.0-rc.33, a release candidate, while `latest` for `@prisma/client` was 7.10.1.
  - A plain install would therefore mix a release-candidate CLI with a stable client.
  - The npm peer range is `*`, but the CLI generates code for the runtime of its own version, and Prisma warns when the versions differ.
  - That is why all three packages are pinned exactly on 7.10.1 (stable, released 2026-10-15).
- Prisma sits behind ports ([ADR 0010](0010-hexagonal-architecture-with-enforced-dependency-rules.md)), so replacing it means changing an adapter. The same contract tests check the new adapter.

## Evidence

n/a

## Follow-ups

- Weekend experiment: a second adapter (for example Kysely) behind the same ports, run against the same contract tests, to show ports and adapters in practice.
