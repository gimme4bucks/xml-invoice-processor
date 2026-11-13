# G09: Operations for the unhappy path

**Goal:** close the one known reliability gap. A document whose message ended in the dead-letter
queue, or that is stuck for any other reason, gets processed again, safely and visibly. The
worker logs what it does with every message.

## Context

Read `CLAUDE.md` (including **Test-driven development**), ADR 0004 (outbox and idempotent
consumer), ADR 0006 (RabbitMQ) and the README's **Reliability** section. Today:

- After a PostgreSQL outage of more than about 2.5 minutes, messages reach `documents.dlq` (delivery limit 10).
- Their documents stay `Received` or `Processing`, and nothing sends them again.

`ProcessDocumentHandler` is already idempotent: the aggregate decides whether an attempt still has
work to do, and appends use optimistic concurrency. Build on that; do not add a second
idempotency mechanism.

G08 (HTTPS) runs at the same time and owns most of `docker-compose.yml`, the e2e tests, the demo
and most of the README. The chaos tests that prove this package end to end come in a later
package (G10), so stay out of `test/e2e`.

## Owned paths

- `apps/service/src/documents/**`, `apps/service/src/app/**`, `apps/service/src/main-worker.ts`, a new `apps/service/src/main-redrive.ts`
- `apps/service/src/shared/logging/**`
- `apps/service/test/unit/**`, `apps/service/test/contract/**`
- **Contract changes, allowed here and to be called out in the PR:**
  - `domain/document-events.ts` (one new event);
  - `application/ports/**` (what the sweeper needs to find stuck documents);
  - `test/contracts/**`;
  - `prisma/schema.prisma` plus a **new** migration, if an index is needed.
- `Dockerfile`: only the `xip` entrypoint (a `redrive` command)
- `docker-compose.yml` and `.env.example`: only new lines for the sweeper settings
- Root `package.json` `scripts` (for example `redrive` for local development)
- `README.md`: only the **Reliability** table and **Next steps**; `docs/adr/0014-recovering-stuck-documents.md` (new)

## Scope

1. **Worker logs:**
   - JSON through pino, like the API, with the same redaction rules.
   - One info line per handled message with `documentId`, `attempt`, `outcome` (completed, failed, retry-scheduled, skipped, or requeued after an error), `durationMs`, `correlationId` and `messageId`.
   - Never XML, amounts, VAT numbers or tokens.
2. **Requeue in the domain and the application:**
   - A new event (for example `ProcessingRequeued { reason: 'dlq-redrive' | 'sweeper' }`) records the requeue in the document's history.
   - The aggregate decides the attempt to ask for: the same attempt while one is in progress, otherwise the next one.
   - A final document cannot be requeued.
   - `RequeueDocumentCommand`, in one unit of work: append the event, update the read model and write an outbox `process` row (with the correlation id header).
   - Outcomes: requeued, already final, not found.
   - Concurrent requeues of the same document: optimistic concurrency lets at most one win.
   - Hard rule 3 holds: nothing publishes except the relay.
3. **DLQ re-drive** (`xip redrive`, plus a local script):
   - Options: `--dry-run`, which lists document IDs and their status and changes nothing, and `--limit N`.
   - Each DLQ message becomes a `RequeueDocumentCommand`. Ack the DLQ message only after that has committed.
   - Messages for documents that are already final are acked and reported.
   - Malformed or failing messages stay in the DLQ: never lost, never looping.
   - Output: a summary with counts and document IDs only. Exit non-zero when something stayed behind.
4. **Sweeper in the worker:**
   - Every `SWEEPER_INTERVAL_MS`, it finds non-final documents whose read model has not changed for `SWEEPER_STUCK_AFTER_MS` and that have no unpublished outbox row. It requeues them (reason `sweeper`) and logs a warning per document, which is the hook for an alert.
   - Safe with several workers.
   - Production-like defaults, such as every minute and stuck after 15 minutes. The threshold must exceed the longest retry delay plus the Schematron timeout.
   - Compose values that suit the demo without disturbing the existing e2e tests; justify the values.
5. **Docs:**
   - ADR 0014: re-drive and sweeper, why both, why through the outbox, and the remaining risks.
   - README: replace the known-gap row in **Reliability** and update **Next steps** item 1.

## Test-driven

Red, green, refactor for every behaviour, at the lowest level that shows it. For example:

- the aggregate's attempt choice;
- requeue of a final document is a no-op;
- concurrent requeues have one winner;
- the sweeper skips documents with pending outbox rows and recent changes (fake clock);
- re-drive acks only after commit and leaves malformed messages in the DLQ;
- the new port methods in the shared contract suite, run against the in-memory and the Postgres adapters.

No sleeps or randomness; use deterministic fault injection.

## Acceptance criteria

- The PR's commits put each red test before its implementation, and **How verified** shows the red and the green runs.
- `pnpm verify` exits 0, and `pnpm test:contract` passes (with your own infra, see below).
- The walking skeleton still passes.
- A PR is open (`feat: DLQ re-drive, stuck-document sweeper and worker logs`), and its CI is green.

## Your infrastructure

G08 uses the default compose project and ports, so use your own: the worktree's `.env` sets
`COMPOSE_PROJECT_NAME=xip-g09` with Postgres on port 55432 and RabbitMQ on 55672 (management
on 55673). Use `pnpm infra:up`, and never touch the `xml-invoice-processor` project's containers.

## /goal condition

```
/goal Work package G09 in docs/goals/G09-unhappy-path.md is done: the worker logs one JSON line per handled message (IDs, attempt, outcome, duration, no content); a RequeueDocumentCommand appends a requeue event and an outbox row in one unit of work (final documents untouched, concurrent requeues have one winner); `xip redrive` (with --dry-run and --limit) moves DLQ messages back through the outbox, acks only after commit and leaves malformed ones in the DLQ; a sweeper in the worker requeues stuck documents without pending outbox rows; ADR 0014 and the README Reliability/Next steps are updated; you followed red-green-refactor from CLAUDE.md (red tests committed before their implementation, red and green runs shown); `pnpm verify` exited 0 and `pnpm test:contract` passed against your own infra project xip-g09 (show both tails); and you opened a PR to main with `gh pr create` whose CI is green (show the URL and `gh pr checks`). Follow CLAUDE.md, do not add npm dependencies. Or stop after 100 turns and report what is missing.
```
