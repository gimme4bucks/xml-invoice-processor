# G10: Chaos tests

**Goal:** prove end to end, against the full compose stack, that no accepted document is lost
and none is processed twice when infrastructure fails hard. That includes the recovery paths from
G09 (`xip redrive` and the sweeper).

## Context

Read `CLAUDE.md` (including **Test-driven development**), ADR 0004, ADR 0006, ADR 0013 (HTTPS:
every test goes through the edge and trusts the exported CA) and ADR 0014. The existing e2e
suite (`apps/service/test/e2e`) already covers a RabbitMQ kill during intake and a short
Postgres pause. Reuse its helpers in `support/stack.ts`.

G11 (credit notes) runs at the same time and edits the e2e documents spec, the demo and the
fixtures. Keep your tests in new files.

## Owned paths

- `apps/service/test/chaos/**` (new), plus additions to `apps/service/test/e2e/support/**` (coordinate in the PR if you change existing helpers)
- The vitest project config for a `chaos` project, and root and service `package.json` `scripts` (`test:chaos`)
- `.github/workflows/ci.yml`: a new `chaos` job only
- `docker-compose.yml`: only if a demo setting must change; justify it in the PR, and production defaults stay as they are
- `README.md`: the **Testing, CI/CD and monitoring** section; `docs/adr/0014-recovering-stuck-documents.md`: its Evidence section

## Scenarios

Each scenario asserts on the document's status and on its event history: exactly one terminal
event, and no attempt processed twice.

1. **Long PostgreSQL outage, then `xip redrive`:**
   - Documents in flight while Postgres stays paused long enough for their messages to be dead-lettered.
   - Unpause, check that the DLQ holds them, run `docker compose run --rm … redrive --dry-run` and then `redrive`.
   - The documents reach `Completed` with `ProcessingRequeued` (reason `dlq-redrive`) in their history.
2. **A lost message, recovered by the sweeper:**
   - A document whose message disappears; for example, purge `documents.process` while the worker is stopped.
   - Without anything else, the sweeper requeues it after `SWEEPER_STUCK_AFTER_MS`, and it ends `Completed` with reason `sweeper`.
3. **Worker killed mid-attempt** (`docker compose kill -s KILL worker` once `ProcessingStarted` is visible):
   - After the restart the attempt resumes and completes.
   - Exactly one `ProcessingStarted` for that attempt.
4. **Poison message:**
   - A malformed message in the DLQ (you may publish it straight to the DLQ to save time) stays there after `redrive`.
   - The redrive exits 1 and reports it as malformed. A second run still finds it.
5. **RabbitMQ killed while the relay publishes a burst** (say 20 documents):
   - All of them complete, none twice.
   - The outbox ends empty of unpublished rows.

## Rules

- **Waiting:** deterministic. Poll with a deadline; never a fixed sleep as the assertion. Waiting on a state change (DLQ depth, status) is fine.
- **Clean up:** every scenario restores the stack it found (unpause, restart, empty DLQ), even when it fails.
- **Time:** the suite stays under about 10 minutes. Prefer shortcuts that keep the behaviour real, such as publishing straight to the DLQ.
- **Not in `pnpm e2e`:** the suite is separate (`pnpm test:chaos`). CI runs it as its own job, in parallel with `e2e`, on pull requests and on `main`.

## Test-driven

These are tests of existing behaviour, so "red" means: show that each scenario's assertion
actually detects the failure. For example:

- run scenario 1 without the `redrive` step and show it times out on `Processing`/`Received`;
- assert the wrong reason and show it fails.

Commit each scenario before any helper or fix that it needs. If a scenario finds a real bug, the
bug fix follows red, green, refactor at the lowest level that shows it (CLAUDE.md), in this PR.

## Acceptance criteria

- `pnpm test:chaos` passes locally against the stack (show the output with timings), and the CI `chaos` job is green.
- The red evidence for each scenario is in **How verified**.
- `pnpm verify` exits 0, and `pnpm e2e` still passes.
- A PR is open (`test: chaos tests against the full stack`).

## /goal condition

```
/goal Work package G10 in docs/goals/G10-chaos-tests.md is done: `pnpm test:chaos` runs the five scenarios from the goal file (long Postgres outage then xip redrive, lost message recovered by the sweeper, worker killed mid-attempt, poison message left in the DLQ, RabbitMQ killed during a publish burst) against the full compose stack over HTTPS, each asserting the status and that the history has exactly one terminal event and no attempt processed twice; for each scenario you showed that its assertion detects the failure (red) before it passed; the suite passes locally in under about 10 minutes (show the output with timings) and in a new CI `chaos` job; `pnpm verify` exited 0 and `pnpm e2e` still passes (show both tails); and you opened a PR to main with `gh pr create` whose CI is green (show the URL and `gh pr checks`). Follow CLAUDE.md, do not add npm dependencies. Or stop after 90 turns and report what is missing.
```
