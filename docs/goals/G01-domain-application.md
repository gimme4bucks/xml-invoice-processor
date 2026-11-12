# G01: Domain & application core

**Goal:** make the domain and use cases complete and proven, including every crash and duplicate
scenario, using only in-memory adapters.

## Context

- Read `CLAUDE.md`, ADRs 0003, 0004, 0005, 0007.
- The foundation already contains the aggregate (`domain/document.ts`), the handlers
  (`application/commands/*`, `application/queries/*`) and the walking skeleton. This package
  hardens and proves them; it does not start over.

## Owned paths

- `apps/service/src/documents/domain/**`
- `apps/service/src/documents/application/**` except `application/relay/**` (G04) and `application/ports/**` (shared contract: propose changes)
- `apps/service/test/unit/**` (new spec files), `apps/service/test/fixtures/**`

## Scope

1. **Value objects with validation:**
   - Idempotency-Key: 1–255 printable ASCII characters.
   - Organisation id: non-empty.
   - Content hash: sha256 hex.
   - PeppolParticipantId: already present; add tests.
   - Use them in the command input, and reject invalid input with a `DomainError` carrying a stable code.
2. **Document state machine:** complete unit tests for every transition and every refused transition. Keep `MAX_PROCESSING_ATTEMPTS` explicit.
3. **Handler tests against the in-memory adapters** (`createInMemoryAdapters`, fault injection by wrapping ports; no sleeps where avoidable):
   - happy path; replay; key reused (409 error); duplicate content under a new key; organisation not a party; race on the idempotency registry (the handler retries once);
   - **crash after `ProcessingStarted` committed:** the redelivered message resumes the same attempt and completes, with exactly one `ProcessingStarted` for that attempt;
   - **duplicate delivery after completion:** skipped, with no new events;
   - **two concurrent deliveries of the same message:** exactly one terminal event; the loser returns `skipped`;
   - **relay re-publishes a message that was already processed:** processed exactly once;
   - **VAT unavailable:** `ProcessingAttemptFailed`, plus a retry message in the outbox with routing key `retry.5s`, then `retry.30s`, then `retry.2m`; after `MAX_PROCESSING_ATTEMPTS` the document is `Failed` and no further retry is enqueued;
   - **VAT invalid:** permanent `Failed`, code `VAT_NUMBER_INVALID`;
   - **fatal rule violations:** `Failed`, code `BUSINESS_RULES_VIOLATED`, with the violations listed. Warnings alone do not fail;
   - **direction:** a purchase checks the supplier's VAT number, a sales invoice checks the customer's;
   - **atomicity:** if any write in the intake unit of work throws, nothing is stored and nothing is enqueued.
4. **Queries:** organisation scoping (another organisation gets `DocumentNotFoundError`); list pagination and status filter; the result is only available when `Completed`; history in version order.

## Out of scope

Real adapters, HTTP, RabbitMQ, Prisma, validation libraries.

## Acceptance criteria

- `pnpm verify` exits 0.
- `pnpm -F @xip/service exec vitest run --project unit --reporter=verbose` lists the scenarios above, all passing, and the walking skeleton is still green.
- `git diff --stat origin/main...HEAD` touches only owned paths.
- A PR is open to `main` (title `feat(domain): …`) with the description sections from `CLAUDE.md`.

## /goal condition

```
/goal Work package G01 in docs/goals/G01-domain-application.md is done: every scenario in its Scope has a passing test; you ran `pnpm verify` and it exited 0 (show the tail of the output); you ran `pnpm -F @xip/service exec vitest run --project unit --reporter=verbose` and the output lists the crash/duplicate/retry scenarios as passing; `git diff --stat origin/main...HEAD` (shown) touches only the owned paths listed in the goal file; and you opened a PR to main with `gh pr create` (show the URL). Follow CLAUDE.md. Do not add dependencies. Or stop after 60 turns and report what is missing.
```
