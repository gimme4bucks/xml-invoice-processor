# 0010. Hexagonal architecture with enforced dependency rules

Status: Accepted (2026-11-12)

## Context

The service has three characteristics that shape its structure:

- **Two sides.** An HTTP side handles intake and queries, and a background side handles processing and publishing.
- **Infrastructure we want to swap.** That covers database access, blob storage, the IdP, the message broker and VIES.
- **Parallel AI sessions.** The work is split across several of them, and they must not erode the structure.

## Decision

- **Ports and adapters.** The layout is:
  - `apps/service/src/documents/{domain, application/{commands,queries,ports}, adapters/{inbound,outbound}}`;
  - `shared/`, for the auth guard, Problem Details, config and logging.
- **Ports:** `EventStore`, `ReadModel`, `BlobStore`, `Outbox`, `DocumentValidator`, `VatNumberVerifier`, `Clock`.
- **Commands and queries.**
  - Commands: `SubmitDocument` in the API, `ProcessDocument` in the worker.
  - Queries: status, list, result and history. All of them read the status table, never the aggregate.
- **Enforced dependency rules,** checked by dependency-cruiser in CI:
  - the domain imports nothing;
  - the application layer imports only the domain;
  - only adapters contain database, RabbitMQ or HTTP code. The application layer may use the NestJS DI and CQRS decorators (`@nestjs/common`, `@nestjs/cqrs`) as a pragmatic exception; the domain stays completely framework-free.
- **`@nestjs/cqrs` buses only.** We use `CommandBus` and `QueryBus`, but not its `AggregateRoot` or `EventBus`.
  - This keeps the domain framework-free.
  - The in-memory event bus is not durable ([ADR 0005](0005-no-saga.md)).
  - Instead, we have our own small `AggregateRoot` base class.
- **One image, two processes.** One codebase and one Docker image, with two start commands (`main-api.ts` and `main-worker.ts`). The two processes scale independently.
  - The API process handles HTTP, auth and intake validation, and talks only to PostgreSQL.
  - The worker process runs the consumer and the outbox relay.
- **Testing along the ports.**
  - Unit tests exercise the pure domain and the handlers with in-memory fakes of the ports, without a mocking framework.
  - Contract tests run the same suite against the fake and against the real adapter.
  - From the first phase, a walking skeleton wires both processes with fakes, so the app runs end to end before the real adapters arrive.

## Alternatives considered

- **eslint-plugin-boundaries for the layer rules.** Considered alongside dependency-cruiser; dependency-cruiser was chosen.
- **`@nestjs/cqrs` `AggregateRoot` and `EventBus`.** Rejected, for the reasons above.

## Consequences

- There are more files and more indirection than in a conventional layered NestJS app.
- Adapters can be swapped, and the same contract tests check the replacement. Examples: Prisma to Kysely, PostgreSQL blob storage to S3, the mock IdP to a real one.
- The parallel work packages own separate folders, and CI catches layer violations mechanically.
- The `CLAUDE.md` architecture rules repeat these constraints for the agents.

## Evidence

n/a

## Follow-ups

- `apps/web`, an admin and support frontend, at the weekend.
