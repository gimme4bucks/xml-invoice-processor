# 0014. Recovering stuck documents: DLQ re-drive and sweeper

Status: Accepted (2026-11-13)

## Context

The guarantee is that an accepted document is processed. One known gap remained:

- During a PostgreSQL outage the worker requeues every message with a back-off (1 s doubling to 30 s). After about 2.5 minutes a message has used up its 10 deliveries, and the quorum queue dead-letters it to `documents.dlq` ([ADR 0006](0006-own-rabbitmq-adapter.md)).
- Its document stays `Received` or `Processing`. It is not lost (the event store has it, the DLQ has the message), but nothing sends it to the worker again.
- A document can also get stuck for reasons we did not foresee: a bug, a queue purged by hand, a message lost in a way the tests do not cover.

`ProcessDocumentHandler` is already idempotent ([ADR 0004](0004-transactional-outbox-and-idempotent-consumer.md)): the aggregate decides whether an attempt still has work to do, and appends use optimistic concurrency. The fix should build on that, not add a second idempotency mechanism.

## Decision

**A requeue is a domain event, and its message goes through the outbox.**

- A new event, `ProcessingRequeued { attempt, reason: 'dlq-redrive' | 'sweeper' }`, records the requeue in the document's history. It does not change the state.
- The aggregate decides which attempt the new message asks for:
  - while an attempt is in progress (the worker died, its message was dead-lettered), the same attempt, so the worker resumes it without a new `ProcessingStarted`;
  - otherwise (`Received`, or the last attempt ended and its retry message was lost), the next one.
- A final document (`Completed` or `Failed`) cannot be requeued.
- `RequeueDocumentCommand` appends the event, updates the read model and writes a `process` outbox row (with the intake's correlation id) in **one unit of work**. Outcomes: `requeued`, `already-final`, `not-found`.
- With an expected version, concurrent requeues of the same document have one winner: the others fail with `ConcurrencyError` (the same `(stream_id, version)` check as every other append).
- Nothing but the relay publishes (hard rule 3). The requeue and its message commit together, so the history and the queue cannot disagree, and the relay's confirms and retries apply as for any other message.

**`xip redrive [--dry-run] [--limit N]`: an operator command for the DLQ.**

- A one-shot process (`docker run <image> redrive`, or `pnpm redrive` locally) with only Postgres and RabbitMQ.
- It takes DLQ messages one at a time with `basic.get` and turns each into a `RequeueDocumentCommand` (reason `dlq-redrive`, causation id = the dead-lettered message's id).
- It acks a message **only after that unit of work committed**, on the channel the message came from. Messages for documents that are already final are acked too, and reported.
- Malformed messages, messages for unknown documents and messages whose requeue failed stay in the DLQ: they are released at the end of the run, so they are never lost and never taken twice in one run.
- A run handles at most the messages that were in the DLQ when it started, and at most `--limit`. A document that is dead-lettered again during the run waits for the next run.
- `--dry-run` lists the document IDs, their status and the attempt a requeue would ask for, and changes nothing.
- Output: a JSON summary with counts and IDs only (stdout; the log lines go to stderr). Exit code 1 when something stayed behind, 2 on a usage or connection error.
- **Released with `nack`, not `reject`.** This is the opposite of hard rule 5, for the opposite reason. The DLQ is a quorum queue without an explicit delivery limit, so RabbitMQ 4.4 applies the default of 20, and the DLQ has no dead-letter target of its own. A message returned 20 times by `reject`, or by a closed channel, is dropped. A `nack` does not count, so a message can be left in the DLQ for any number of runs.

**A sweeper in every worker.**

- Every `SWEEPER_INTERVAL_MS` it looks for documents that are not final, whose read model has not changed for `SWEEPER_STUCK_AFTER_MS`, and that have no unpublished outbox row (a message waiting for the relay is not stuck: the broker is just down).
- It requeues each one (reason `sweeper`) with the version it found as the expected version, and logs a warning per document: the hook for an alert.
- Safe with several workers: the expected version lets one sweeper win per document; the others count it as skipped. No leader election.
- Defaults: every minute, stuck after 15 minutes. The threshold must exceed the longest retry delay plus the Schematron timeout (2 min + 30 s by default), or the sweeper would requeue healthy documents that are waiting for a retry; the worker refuses to start otherwise.
- Compose (demo): every 10 s, stuck after 90 s. A healthy document in that stack stays unchanged for at most about 65 s (5 s retry, 30 s Schematron, 30 s requeue back-off), and the e2e outages are shorter, so the e2e tests never see a requeue.
- The query uses a new `(status, updated_at)` index on `document_views`; the `NOT EXISTS` only reads pending outbox rows (`outbox_pending_idx`).

**Worker logs.** The worker logs one JSON line per handled message through pino, with the API's logger settings: `documentId`, `attempt`, `outcome` (`completed`, `failed`, `retry-scheduled`, `skipped`, or `requeued` after an error), `durationMs`, `correlationId` and `messageId`. Never content, amounts, VAT numbers or tokens, and not the error message either (it may quote input).

### Why both

- **The re-drive is precise and deliberate.** The DLQ says exactly which messages died. After an incident an operator looks first (`--dry-run`), then sends them back in one go, without waiting 15 minutes. Poison messages stay visible in the DLQ instead of looping.
- **The sweeper is the safety net for the guarantee.** It needs no operator and no DLQ: it finds every stuck document, whatever lost its message. On its own it would be slow (15 minutes), and the DLQ would keep filling with stale messages.

## Alternatives considered

- **Moving DLQ messages back to `documents.process` (a shovel, or the management UI's "move messages").** This bypasses the aggregate: no history, and the message keeps its old attempt number. A message for an attempt that already ended is skipped by the worker, so the document stays stuck.
- **Publishing from the re-drive.** It breaks hard rule 3 and is a dual write: a crash between the publish and the history leaves them disagreeing. The outbox already solves this.
- **A DLQ consumer in the worker that requeues automatically.** Poison messages would loop quickly and invisibly. The DLQ is for an operator decision.
- **An inbox table or a "requeue pending" flag.** A second idempotency mechanism. The worker's handler already decides from the state, and optimistic concurrency already gives one winner.
- **Leader election for the sweeper.** Not needed for correctness; several sweepers only cost a few duplicate queries.
- **An explicit `x-delivery-limit` on the DLQ.** Changing the arguments of an existing queue is refused (406); it needs a policy (see Follow-ups).

## Consequences and remaining risks

- A requeue adds an event, so the history shows when and why a document was sent again. A requeued document's history has one more entry than before (`ProcessingRequeued`).
- **Poison documents loop slowly.** A document that always crashes the worker is dead-lettered after 10 deliveries, swept again after 15 minutes, and so on: about every 20 minutes, with a warning each time. We prefer a visible slow loop to giving up silently. See Follow-ups.
- **A backlog longer than the threshold causes duplicate requeues.** If a document waits in `documents.process` for more than 15 minutes, the sweeper requeues it, and the worker skips the duplicate. Harmless, but noisy: alert on the queue depth too.
- **A crashed re-drive counts.** Messages it holds are returned by the closed channel, which counts toward the DLQ's default limit of 20. Twenty crashed runs in a row would drop a message.
- **The re-drive and the sweeper can both requeue the same document.** The second message is skipped by the worker.
- **Messages for unknown documents stay in the DLQ** until an operator removes them. Deliberate: it points at a wrong database or a bug, and it is visible.
- The sweeper compares the read model's `updated_at` (set by the writing process) with its own clock. Clock skew of seconds is irrelevant next to a 15-minute threshold.

## Evidence

- Unit (in-memory adapters, deterministic fault injection): the aggregate's attempt choice and the refusal of final documents (`document.spec.ts`); one unit of work, rollback, one winner, stale versions and dry runs (`requeue-document.spec.ts`); the sweeper with a fake clock, skipping recent changes and pending outbox rows, two concurrent sweepers (`sweeper.spec.ts`); the re-drive acking only after the commit, leaving malformed, unknown and failing messages, `--limit` and the start depth (`dlq-redrive.spec.ts`); the worker's log lines (`worker-logging.spec.ts`); the sweeper wired into the worker (`sweeper-loop.spec.ts`).
- Contract: `DocumentViews.findStuck` against the in-memory and the Postgres adapters; the RabbitMQ dead-letter source, including a message released 25 times that is still there.
- Probe on RabbitMQ 4.4.0 (quorum queue, no explicit limit, 25 returns): `reject` → gone after 20 returns; channel close → gone after 20; `nack` → still there. Replacing `nack` by `reject` makes the contract test fail.

## Follow-ups

- Alerts on the sweeper's warnings and on the depth of `documents.dlq`.
- A cap on sweeper requeues per document, after which it fails with a stable code (ends the slow poison loop).
- A `delivery-limit` policy on `documents.dlq` that lifts the default of 20.
- Chaos tests (G10) that prove the recovery end to end: a long PostgreSQL outage, then the sweeper and `xip redrive`.
