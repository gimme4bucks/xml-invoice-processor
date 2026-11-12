# CLAUDE.md: xml-invoice-processor

Read this fully before changing anything. It applies to every session and work package.

## What this is

A backend that B2B systems (organisations, not people) use to submit **Peppol BIS Billing 3.0
invoices (UBL 2.1 XML)** over HTTP. Documents are validated, stored and then processed
asynchronously. Clients follow each document's status: `Received`, `Processing`, `Completed` or `Failed`.
Accepted documents must never be lost, processing may fail, and the same invoice must not be
processed twice.

It is a take-home assignment. Reviewers care about **choices, trade-offs and reliability
reasoning** more than feature count. Code must stay small, explicit and explainable. When in
doubt, choose the boring and visible option.

## Decisions (do not re-open without the coordinator)

ADRs live in `docs/adr/`, spike evidence in `docs/spikes/`. In short:

- **Format:** Peppol BIS 3.0 (UBL 2.1 Invoice). CreditNote is rejected as "not supported yet".
- **Validation is split.** Structure (DOCTYPE ban, root element, UBL 2.1 XSD via libxml2-wasm) runs **synchronously at intake**. The official EN 16931 + Peppol Schematron rules (SaxonJS) run **asynchronously in the worker**; a fatal violation means `Failed`.
- **Event sourcing in Postgres:** one stream per document, a read model updated **in the same transaction**, and a DB trigger that makes events append-only.
- **Transactional outbox.** Only the outbox relay publishes to RabbitMQ. Consumers are idempotent through the aggregate state plus optimistic concurrency on `(stream_id, version)`. There is no inbox table and no saga.
- **RabbitMQ through our own adapter** (amqplib + amqp-connection-manager; spike 02b).
- **Idempotency:** a required `Idempotency-Key` per organisation, plus a SHA-256 content hash. A byte-identical file sent again under a new key is a 409.
- **Auth:** OAuth2 client-credentials JWTs from a mock IdP. Claims are `sub`, `org_id`, `peppol_id` and `scope` (`documents:submit`, `documents:read`). The organisation **always comes from the token**. Another organisation's document returns 404. Purchase vs sales is derived from `peppol_id` vs the invoice's supplier/customer EndpointID.
- **Responses:** JSON. Errors are **RFC 9457 Problem Details** with a stable `code`.
- **Data access:** Prisma 7. Documents are stored in Postgres behind the `BlobStore` port (S3 later).
- **Process VAT check:** a fake VIES adapter. `invalid` means permanent `Failed`; unavailable means retry with backoff through the outbox and the retry delay queues.

## Layout

```
apps/service/src/
  documents/domain/            pure TypeScript: Document aggregate, events, value objects
  documents/application/       use cases (commands/queries), ports, relay
  documents/adapters/inbound/  HTTP controllers, message consumers, relay loop
  documents/adapters/outbound/ in-memory, postgres, rabbitmq, validation, vies, system
  app/                         composition root (port bindings, Nest modules)
  shared/                      config, cross-cutting HTTP concerns (auth, problem details, logging)
  main-api.ts / main-worker.ts two processes, one image
apps/service/test/
  contracts/                   port contract suites (shared by in-memory and real adapters)
  unit/                        in-memory runs of the contracts + walking skeleton
  contract/                    real-adapter runs of the contracts (needs infra)
  e2e/                         full stack via docker compose
apps/mock-idp/                 OAuth2 client-credentials issuer for dev/demo/e2e
```

## Hard rules

1. **Layers** (enforced by `pnpm depcruise`):
   - The domain imports nothing outside the domain.
   - The application imports only the domain, Node built-ins and `@nestjs/common` / `@nestjs/cqrs`.
   - Prisma is used only in `adapters/outbound/postgres`; amqplib only in the rabbitmq/messaging adapters.
   - Port bindings live only in `src/app`.
2. **Every write goes through `UnitOfWork.run` and passes its `tx`.** Event, read model, blob, outbox and idempotency record are written in one transaction.
3. **Only the outbox relay publishes.** If something needs a message, it writes an outbox row in the same unit of work. Never use the in-memory `EventBus`, sagas or the `@nestjs/cqrs` `AggregateRoot` for anything that must not be lost.
4. **Events are immutable.** Never update or delete events, and never edit an applied migration; add a new one.
5. **RabbitMQ:**
   - Publish with confirms, `mandatory: true` and a timeout. A rejected publish means _unknown_, not _not delivered_.
   - Ack only after the handler's transaction has committed, and ack on the delivery's own channel.
   - Requeue with `reject(msg, true)`, never `nack`: on RabbitMQ 4.4, `nack` does not count towards `x-delivery-limit`.
   - Fail fast (exit) on an unexpected channel close or consumer cancel.
6. **Security:**
   - Organisation scoping only from token claims, never from the URL or body.
   - Reject any DOCTYPE; never resolve external entities or fetch over the network while parsing.
   - Never log XML content, amounts, VAT numbers or tokens; log IDs only.
   - No secrets in the repo: use `.env` (gitignored) and `.env.example`.
7. **Dependencies are installed and pinned.**
   - Do not add, remove or upgrade packages, and do not edit `pnpm-lock.yaml`. If you need one, stop and say so in the PR description.
   - Adding `scripts` entries to a `package.json` is allowed.
   - Never use prereleases. pnpm refuses versions younger than 3 days (`minimumReleaseAge`).
   - Use TypeScript 5.9.3, not 7.
8. **Shared contracts change only through the coordinator:** `application/ports/**`, `domain/document-events.ts`, `prisma/schema.prisma`, `test/contracts/**`. If you need a change, propose it in the PR description, or make it minimal and call it out explicitly.
9. **Stay inside your work package's owned paths** (see its goal file).
   Work on your `goal/*` branch only. Never push to `main` and never merge PRs yourself: open
   a PR with `gh pr create`; a human reviews and squash-merges.
10. **Write everything in English** (code, comments, docs, commit messages). Use Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`…).
11. **Do not use `import type` for classes that Nest injects.** It strips the decorator metadata that DI needs.

## Commands

```bash
pnpm install                         # workspace install (pnpm 10 via Corepack)
pnpm infra:up / pnpm infra:down      # Postgres 18 + RabbitMQ 4.4 in Docker (profile "infra")
pnpm -F @xip/service prisma:generate # generate the Prisma client into src/generated (gitignored)
pnpm -F @xip/service prisma:migrate  # apply migrations to DATABASE_URL
pnpm test                            # unit project: domain, handlers, in-memory contracts, walking skeleton
pnpm test:contract                   # contract project: real adapters (needs infra + migrations)
pnpm verify                          # what CI's verify job runs: format, lint, types, depcruise, unit, build
pnpm -F @xip/service build           # SWC build to dist/ (the Nest CLI does not run on Node 22.14)
ADAPTERS=in-memory pnpm -F @xip/service start:api   # walking skeleton API on :3000
```

Copy `.env.example` to `.env` (repo root and `apps/service/`) for local work.

## Testing strategy

- **Unit:** the domain and the command/query handlers against the in-memory adapters. Test crash scenarios with deterministic fault injection (no sleeps, no randomness).
- **Contracts:**
  - `test/contracts/*.contract.ts` defines the behaviour of a port. It runs against the in-memory adapters (`test/unit/in-memory-adapters.spec.ts`) **and** against the real adapters (`test/contract/*.contract.spec.ts`).
  - A real adapter is done when it passes the same suite.
- **Walking skeleton:** `test/unit/walking-skeleton.spec.ts` must stay green. It proves the API and worker wiring end to end.
- **E2E (G07):** the full stack via compose, including infrastructure outages.

## Definition of done (every work package)

1. `pnpm verify` exits 0. `pnpm test:contract` passes for adapters you touched (with `pnpm infra:up`).
2. `git diff --stat origin/main...HEAD` shows changes only in your owned paths (plus explicitly called-out contract changes).
3. The PR to `main` has a Conventional Commit title, and its description has these sections:
   - **What**
   - **How verified** (commands + results)
   - **Decisions & trade-offs** (the coordinator folds these into ADRs and the AI log)
   - **Contract changes**
   - **Open points**
4. CI is green. A human reviews before merge (squash merge).

## Known pitfalls (from the spikes)

- **libxml2-wasm:**
  - Parse with `NONET | NO_XXE`, never `NOENT`.
  - Reject when `doc.dtd` is set. Check the root namespace and name.
  - Always `dispose()`; WASM memory is not garbage-collected.
- **SaxonJS:**
  - `transform` blocks the event loop, so run it in `worker_threads` (piscina) with a timeout.
  - Load each SEF once per thread.
  - Pin CEN 1.3.16 together with Peppol 3.0.22.
  - Only `fatal` flags reject.
  - Filter the false DE-R-019/020 warnings (a SaxonJS bug with big integers in `mod`).
- **Artefact licences:**
  - The Peppol `.sch` has no licence: fetch it at build time from a pinned URL with a sha256 check, and never commit it.
  - UBL 2.1 XSDs (OASIS) and the CEN XSLT (EUPL-1.2) may be committed unmodified, together with their licences.
  - SaxonJS may be a dependency but must never be vendored; credit it in THIRD-PARTY-NOTICES.
- **RabbitMQ 4.4:**
  - At-least-once dead-lettering needs `x-dead-letter-strategy: at-least-once` together with `x-overflow: reject-publish`.
  - Broker restarts and crashes also raise `x-delivery-count`, so use a limit of about 10.
  - `docker restart` is too gentle for crash tests; use `docker pause` or `docker kill -s KILL`.
- **Prisma 7:**
  - The `prisma-client` generator writes to `src/generated/prisma`. The PrismaClient needs `@prisma/adapter-pg`, and the config lives in `prisma.config.ts`.
  - A unique-constraint violation is `P2002`.
  - Prisma refuses `migrate reset` from AI agents; do not bypass it. Use a fresh schema per test run instead.
- **The events table blocks TRUNCATE/DELETE.** Test isolation needs its own schema, or `session_replication_role = replica` in test-only code.

## Spike code

Copied (without dependencies and downloaded artefacts) to `docs/spikes/code/`. Use it as a
starting point, not as production code:

- `01-validation/`: libxml2-wasm XSD (`lib/xsd-libxml2.mjs`), SaxonJS Schematron (`lib/schematron.mjs`),
  SEF build (`build-sef.sh`). Artefact URLs and sha256 sums are in `docs/spikes/01-validation.md`.
- `02b-rabbitmq-amqplib/`: the chosen RabbitMQ adapter (`src/amqp/*`) and its crash tests (`test/*`).
- `02a-rabbitmq-golevelup/`: the alternative that was not chosen (kept as evidence).
