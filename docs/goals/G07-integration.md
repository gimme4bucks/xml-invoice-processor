# G07: Integration, end-to-end tests and demo

**Goal:** wire the real adapters, prove every decision end to end against the full stack, and
provide a one-command demo.

## Context

All earlier packages are merged. Read `CLAUDE.md` and every ADR. The walking skeleton shows the
expected flow; this package swaps in the real adapters.

## Owned paths

- `apps/service/src/app/**`, `apps/service/src/main-*.ts`
- `apps/service/test/e2e/**`
- `scripts/demo/**`, `examples/**`
- Root `package.json` `scripts` (`demo`, `e2e`)

## Scope

1. **`realProviders(config)`:** postgres + rabbitmq + validation + vies + system adapters. `WorkerModule` uses the RabbitMQ consumer when `ADAPTERS=real`. Validate the config for the real adapters (a missing `DATABASE_URL`/`AMQP_URL` is a startup error). Graceful shutdown.
2. **E2E** (`test/e2e`, full stack via compose; real HTTP with mock-idp tokens):
   - the happy path to `Completed`, then the result and the history;
   - XSD rejection (422);
   - a Peppol rule violation ending in `Failed`, with BR-CO rule ids;
   - VIES unavailable, retries, then `Completed`;
   - an invalid VAT number ending in `Failed`;
   - idempotency: a replay returns the same id; a key reused with other content is 409; the same file under a new key is 409;
   - auth: 401 and 403, and 404 for another organisation;
   - CreditNote rejected;
   - **RabbitMQ stopped during intake:** 202 anyway, and `Completed` after the restart;
   - **Postgres stopped:** 503, then a retry with the same key yields one document.
3. **`pnpm demo`:** gets a token from mock-idp and walks through the scenarios against the running stack with readable output (examples in `examples/`).
4. **README Quick start section:** coordinate with the coordinator, who owns the rest of the docs.

## Acceptance criteria

- The CI `e2e` job is green on the PR.
- `pnpm demo` runs cleanly against `docker compose --profile full up` (show the output).
- `pnpm verify` exits 0.
- A PR is open (`feat: wire real adapters and e2e`).

## /goal condition

```
/goal Work package G07 in docs/goals/G07-integration.md is done: ADAPTERS=real wires postgres, rabbitmq, validation and vies adapters; every e2e scenario in the goal file (including RabbitMQ-down and Postgres-down) passes against the full compose stack (show the test output); `pnpm demo` runs cleanly against the stack (show the output); `pnpm verify` exited 0 (show the tail); and you opened a PR to main with `gh pr create` whose CI e2e job is green (show the URL and `gh pr checks`). Follow CLAUDE.md, do not add dependencies. Or stop after 80 turns and report what is missing.
```
