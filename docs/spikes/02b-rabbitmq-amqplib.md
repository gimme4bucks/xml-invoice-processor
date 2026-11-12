> The spike code is copied to [`code/`](code/) (without dependencies and downloads); `<scratch>` paths below refer to the original local scratch directory.

# Spike 02b: RabbitMQ with plain amqplib + amqp-connection-manager (own adapter)

Spike code: `<scratch>/spike-rabbitmq-amqplib`. In this report, `src/...` and `test/...` are relative to that folder.
Broker: own container `spike-rmq-b` (RabbitMQ **4.4.0**, `rabbitmq:4-management-alpine`, ports 5674/15674). It was removed at the end.

## TL;DR

- **T1 to T6 all PASS** against the final adapter. 0 confirmed messages were lost in every restart or crash scenario.
- **Biggest finding (affects both approaches):** on RabbitMQ 4.x, `basic.nack(requeue=true)` does **not** count toward `x-delivery-limit`. With nack, the poison message looped **23,771 times in about 20 s** and never reached the DLQ. `basic.reject(requeue=true)` does count. With reject, the message reached the DLQ after 4 deliveries (`x-delivery-count: 4`, reason `delivery_limit`). The spec says "nack with requeue"; **this adapter deviates on purpose and uses reject**. The golevelup spike saw the same thing (per the coordinator). Broker restarts and consumer crashes also raise `x-delivery-count` (verified in T5 and T6).
- **At-least-once dead-lettering works, but only with `x-overflow: reject-publish`.** Without it, RabbitMQ silently falls back to at-most-once. The only sign is a broker-log warning; the client gets no error. Verified by running it: with the DLQ unroutable, the at-most-once queue and the "at-least-once without reject-publish" queue both **lost** the message. The at-least-once queue kept it and delivered it once the DLQ was routable again. Caveat: the redelivery came only after the broker's 180 s retry timer.
- amqp-connection-manager's own `publish()` **buffers unsent messages in memory** across a reconnect. Its promise still means "broker-confirmed", but on the new channel. Messages that were **already sent but not yet confirmed** when the connection dies are **rejected** (`channel closed`), not re-sent. The outbox is already our durable buffer, so the adapter does **not** use that buffer: it publishes on the raw confirm channel and fails fast.
- Adapter size: **273 lines in 5 files, about 202 non-blank, non-comment lines.**

## Pinned versions (exact, `--save-exact`)

| package | version | note |
|---|---|---|
| amqplib | 2.3.1 | `latest`. Published 2026-11-08, only 4 days before this spike. Bundles its own types since 1.2.0, so no `@types/amqplib`. |
| amqp-connection-manager | 5.0.1 | `latest`. peerDep `amqplib: "*"`, devDep `amqplib ^2.2.0`, so it is built against 2.x. **Works with amqplib 2.3.1**: all tests pass, and its `.d.ts` files resolve against amqplib's bundled types. |
| @nestjs/core, @nestjs/common | 12.5.0 | `latest` |
| reflect-metadata | 0.2.2 | `latest`; Nest peer range `^0.1.12 \|\| ^0.2.0` |
| rxjs | 7.8.2 | `latest`; Nest peer range `^7.1.0` (9.0.0-beta is tagged `next`, not used) |
| typescript (dev) | 5.9.3 | `latest` is 7.0.2 (the native port). I chose 5.9.3 because it definitely supports `emitDecoratorMetadata`; TS 7 was not tested. |
| @types/node (dev) | 22.20.5 | matches Node 22.14.0 |

No rc, alpha or beta versions were installed; I checked `npm view <pkg> dist-tags` first. The build is `tsc` (with `experimentalDecorators` and `emitDecoratorMetadata`), run with plain `node`. Nest constructor injection worked, confirmed by `app.get(ConfirmPublisher)` resolving `AmqpConnection` without `@Inject`.

## Test results (all **verified by running**)

Run with `npm run build && npm run t1` … `t6`. Raw output is in `results.log` in the spike folder. Earlier failing runs are kept in it.

| test | result | numbers |
|---|---|---|
| **T1** 200 publishes with confirms | PASS | 200/200 confirmed in 11–19 ms; 200 consumed; **0 duplicates**. Side check: publishing to an unroutable key → `rejected: unroutable (returned)` (it does not resolve). |
| **T2** retry queue TTL | PASS | `retry.1s` → arrived on `documents.process` after **1011 ms**; `retry.3s` → **3014 ms**. `x-death[0].queue` = the retry queue, count 1. |
| **T3** poison → DLQ | FAIL with `nack`, **PASS with `reject`** | With `nack(requeue)`: 23,771 handler attempts, never dead-lettered, and **no `x-delivery-count` header**. With `reject(requeue)`: **4 handler attempts**. `x-delivery-count` seen by the handler was absent, 1, 2, 3; on the DLQ copy it is **4**. `x-first-death-reason: delivery_limit`, `x-death: {queue: documents.process, reason: delivery_limit, count: 1}`. The 5 good messages were all processed and the work queue ended empty. |
| **T3b** at-least-once dead-lettering (`test/t3b-dlx-strategy.ts`, raw amqplib) | PASS | Three quorum queues dead-letter (reject, no requeue) into an exchange with **no binding**. After the reject: `at-least-once + reject-publish` → `messages: 1, messages_dlx: 1` (**retained**); `at-least-once` without reject-publish → `0/0` (**lost**; broker log: "Falling back to dead-letter-strategy at-most-once"); default at-most-once → `0/0` (**lost**). After binding a DLQ, only the at-least-once message arrived, **after 173.8 s** (first run 178.7 s), i.e. the broker's 180 s `dead_letter_worker_publisher_confirm_timeout` retry. (The first T3b run is logged as FAIL only because the management stats had not refreshed yet; the outcome was the same.) |
| **T4** 500 publishes during `docker restart` | PASS | **395 confirmed / 105 rejected / 396 consumed / 0 lost-confirmed**. Rejections: 104 × `publisher not connected` (fail fast while down), 1 × `channel closed` (in flight at the close). That one rejected message **was still delivered**, which is the expected at-least-once duplicate if the outbox re-sends it. 295 confirmed after the restart without any process restart. |
| **T4 (kill variant)** `docker kill -s KILL` + `docker start` | PASS | **423 confirmed / 77 rejected / 423 consumed / 0 lost-confirmed** after an unclean broker crash. Confirmed messages on the quorum queue survived the crash. |
| **T5** `docker restart` during slow consumption (700 ms handler, prefetch 2) | PASS | 20/20 committed, **0 lost** (same numbers in 3 runs). The 2 in-flight messages committed during the outage, their ack failed (`Channel closed`), and they were **redelivered 2×**, giving 2 duplicate commits. **Both redeliveries carry `x-delivery-count: 1`**, so a broker restart during processing counts toward the delivery limit. Broker was down for 3014 ms. The consumer resumed by itself; the first commit on the new channel came 725–883 ms after reconnect (≈ one handler duration). 14 commits after reconnect. |
| **T6** SIGKILL after commit, before ack | PASS | Run 1: committed `t6-1` (`redelivered=false`), then was killed by SIGKILL in the `beforeAck` hook. Run 2: **same message redelivered** with `redelivered=true x-delivery-count=1`; the idempotency check logged `duplicate-skipped`. Queue empty afterwards. Note that a consumer crash **also counts toward the delivery limit**, so a message that crashes the worker every time ends in the DLQ after 3 crashes. |

Simulated DB from T6 (`t6-db.log`):
```
commit t6-1 pid=31478 redelivered=false x-delivery-count=-
duplicate-skipped t6-1 pid=31479 redelivered=true x-delivery-count=1
```

### Extra experiments: how amqp-connection-manager's built-in publish behaves (verified)

| exp | setup | result |
|---|---|---|
| E1 | `ChannelWrapper.sendToQueue` (confirm channel, `timeout: 60s`), 300 msgs paced 40 ms, `docker restart` | 73 calls made while disconnected were **buffered** (max buffer 73) and **all resolved after reconnect**. 300/300 in the queue, 0 duplicates, 0 lost. |
| E1 burst | same, 15,000 msgs (restart) / 15,000 and 60,000 msgs (SIGKILL) | All resolved, all present, 0 duplicates, 0 lost. Up to 19,600 messages buffered in process memory. |
| E2 | `docker pause` (broker frozen), then 20 publishes on each client; the heartbeat kills the connection; then unpause | **acm:** all 20 sent-but-unconfirmed were **rejected `channel closed`**, not re-sent. 1 of them still reached the queue. **Our adapter:** all 20 rejected `confirm timeout` after 5 s. Its connection survived the 7 s pause (heartbeat 5 s), so **all 20 were enqueued after unpause**. A rejection means "outcome unknown", not "not delivered". |

## How in-flight publishes behave during a reconnect (question from the brief)

From the E1/E2 runs (verified) and from reading `node_modules/amqp-connection-manager/dist/cjs/ChannelWrapper.js` and `node_modules/amqplib/lib/channel.js` (inferred where noted):

1. **Not yet written to a channel** (called while disconnected or before setup finished): `ChannelWrapper.publish/sendToQueue` keeps them in an in-memory array (`_messages`) and sends them after reconnect and after all setup functions have run. The promise resolves only when the confirm for that message arrives on the new channel. **So yes, it buffers, and yes, a resolve still means "confirmed by the broker".** Verified (E1). Without a `timeout`/`publishTimeout` option the promise stays pending for the whole outage. If the process dies meanwhile, the buffer is lost.
2. **Already sent, not yet confirmed** when the connection drops: amqplib ≥ 1.0.5 calls every pending confirm callback with `Error('channel closed')`. acm's `_messageRejected` would re-queue the message only if `this._channel` were already cleared. amqplib's own `'close'` listener is registered first, in the channel constructor, so the callbacks run while `_channel` is still set and acm **rejects** the promise. Verified (E2: 20/20 `channel closed`). The ordering explanation is inferred from the code. The comment in acm, "We never get any kind of error for messages in flight", is out of date with amqplib 2.x.
3. Timeout: on `timeout`, acm removes the message from its buffers and rejects. If the message was already sent, it may still be delivered (inferred from code; the same effect was verified for our adapter in E2).

**Decision in the adapter:** do not use acm's buffer. The outbox table is the durable buffer and the relay is the retry loop, so a second, volatile in-memory queue only hides state: unbounded memory, a pending promise that blocks the relay during an outage, and a lost buffer on crash. `ConfirmPublisher` uses acm only for the connection and channel lifecycle and the per-reconnect setup. It publishes on the raw `ConfirmChannel` captured in the setup function and **fails fast**.

## How the adapter makes sure a publish never resolves without a real broker confirm

All in `src/amqp/confirm-publisher.ts`:
- `:34` the channel is a **confirm channel**.
- `:53` there is **no live channel → reject immediately** (`publisher not connected`). Nothing is buffered.
- `:66-84` `ch.publish(..., callback)`: **`resolve()` is reachable only from inside amqplib's per-message confirm callback** (`:82`), and only when `err` is empty.
- `:80` a nack → reject; a channel/connection close with the message unconfirmed → amqplib passes `channel closed` → reject.
- `:72` + `:38` + `:81` `mandatory: true`. An **unroutable message gets a basic.ack too** (classic gotcha). The broker sends `basic.return` before that ack, so a returned messageId is turned into a reject (verified, T1 side check).
- `:63` 5 s confirm timeout → reject. `:57-62` the `settled` flag makes the first outcome win, so a late ack after a timeout is ignored.
- `:85-86` a synchronous throw from `publish` on a closed channel (IllegalOperationError) → reject.
- `:39` the cached channel is dropped on `close`, so the next publish fails fast instead of writing into a dead channel.
- `:71,:73,:74` `persistent: true`, `messageId`, `contentType: application/json`; `:69` JSON body.

Consequence for the relay (verified in T4 and E2): **resolved ⇒ the broker has it (0 lost-confirmed in every run). Rejected ⇒ unknown**: 1/105 in T4 and 20/20 in E2 were delivered anyway. Leaving the row unpublished and re-sending is correct, and the consumer must be idempotent.

## Where each guarantee lives (file:line)

| guarantee | location |
|---|---|
| Publisher confirms | `src/amqp/confirm-publisher.ts:34` (confirm channel), `:53` (fail fast), `:63` (timeout), `:66-84` (publish + resolve only in the confirm callback), `:72/:38/:81` (mandatory + return → reject) |
| Ack only after commit | `src/amqp/document-consumer.ts:32` (`noAck: false`), `:49` (`await handler`, i.e. the DB commit), `:57-58` (`ack` after the handler resolves), `:44` (ack on the channel the delivery came from) |
| Prefetch 2 | `src/amqp/document-consumer.ts:31` (`PREFETCH` at `:15`) |
| Failure → requeue, counted by the delivery limit | `src/amqp/document-consumer.ts:59-63` (`ch.reject(msg, true)`, **not** nack) |
| DLQ | `src/amqp/topology.ts:31-34` (DLX + quorum DLQ), `:36-45` (`documents.process`: quorum, `x-delivery-limit: 3`, DLX args), `:19-22` (at-least-once + reject-publish) |
| Retry queues | `src/amqp/topology.ts:12-15` (routing keys `retry.1s`/`retry.3s`, TTLs), `:48-60` (quorum + TTL + dead-letter back to `documents`/`process`, bound to `documents`) |
| Reconnect | `src/amqp/amqp-connection.ts:17-20` (`amqp.connect`, heartbeat 5 s, reconnect every 1 s); channels are re-created by acm and re-run their `setup`: `confirm-publisher.ts:36-41`, `document-consumer.ts:29-33` |
| Redelivery on lost ack | `src/amqp/document-consumer.ts:64-68` (ack on a dead channel is caught; the broker redelivers) |
| Topology at startup, idempotent | `src/amqp/topology.ts:29` `assertTopology`, called from `confirm-publisher.ts:37` and `document-consumer.ts:30` on every (re)connect |
| Nest wiring | `src/amqp/amqp.module.ts` (`AmqpModule.forRoot(url)`), `src/amqp/amqp-connection.ts` (provider owning the manager) |

**How retry queues are addressed:** each retry queue is bound to the **same `documents` exchange** under its own routing key. A retry is therefore `publish('retry.1s', payload, {messageId})`, through the same confirmed publisher with no second API. On TTL expiry the message dead-letters to `documents` with routing key `process`. `x-death` records the hop (seen in T2). Who decides to retry (the consumer catching a transient error, re-publishing to `retry.Ns` and acking the original) is not part of this spike.

## Lines of code (adapter only, excluding tests)

| file | lines | non-blank, non-comment |
|---|---|---|
| `src/amqp/amqp-connection.ts` | 29 | 20 |
| `src/amqp/amqp.module.ts` | 15 | 14 |
| `src/amqp/confirm-publisher.ts` | 94 | 71 |
| `src/amqp/document-consumer.ts` | 74 | 52 |
| `src/amqp/topology.ts` | 61 | 45 |
| **total** | **273** | **≈202** |

Tests and experiments: 10 files, 633 lines.

## Gotchas, workarounds, things that did not work

1. **Deviation from the spec: `nack(requeue)` is not counted by the quorum-queue delivery limit on RabbitMQ 4.x**, so the consumer uses `reject(requeue)`. Verified here, and the coordinator reports the same from the golevelup spike: about 24,000 redeliveries in 30 s. It matches the docs at rabbitmq.com/docs/quorum-queues: nack/`released` don't increment, reject/crash do. With nack you get an endless hot loop of about 1,000 deliveries per second and no `x-delivery-count` header. **Use `basic.reject(requeue=true)`**, which is counted. A consumer crash (T6) and a **broker restart during processing** (T5) are also counted (`x-delivery-count: 1` on redelivery). Consequence: with `x-delivery-limit: 3`, a healthy message that happens to be in flight during 3 crashes or restarts lands in the DLQ. DLQ messages must therefore be replayable, and a slightly higher limit (5–10) may be worth considering.
2. **At-least-once DLX silently degrades** without `x-overflow: reject-publish`. The broker log says `Falling back to dead-letter-strategy at-most-once ... incompatible with effective overflow strategy drop-head`, and the client sees nothing. Re-delivery to an unroutable DLX waits for `dead_letter_worker_publisher_confirm_timeout` (180 s default). Side effect of `reject-publish`: if a max-length is ever added, publishes get **nacked** instead of dropping old messages, which the confirm-based publisher handles as a reject.
3. **Unroutable messages are positively confirmed** (the coordinator saw the same in the golevelup spike). **`mandatory: true` + handling `basic.return` closes the gap. Verified:** T1's side check publishes to `no-such-routing-key` and gets `rejected: unroutable (returned)` instead of a resolve (adapter `confirm-publisher.ts:38`, `:72`, `:81`). This relies on RabbitMQ sending `basic.return` before the `basic.ack` for the same message. Small leak (inferred, not hit): a returned id whose ack never arrives stays in the `returned` Set.
4. **Ack on the delivery's own channel.** `ChannelWrapper.ack()` acks on the *current* channel. After a reconnect, an old delivery tag on a new channel causes `PRECONDITION_FAILED - unknown delivery tag`, which closes the new channel (inferred from the code and AMQP semantics, not provoked). The adapter therefore consumes inside the setup function and captures `ch` (`document-consumer.ts:32`), instead of using `ChannelWrapper.consume()`.
5. **acm only re-creates channels on a connection reconnect**, not after a channel-level error (`_onChannelClose` just waits; inferred from code). Example: changing queue arguments of an existing queue (say a different `x-delivery-limit`) gives a 406 in `assertTopology`. The setup then fails with only an `error` event, and `waitForReady()` never resolves. Queue-argument changes need a new queue name or a policy. Not handled in the spike; a production version should fail startup loudly. Consumer-cancel notifications (`msg === null`) are only logged, not re-subscribed.
6. **`docker restart` is graceful.** The broker flushes confirms before closing, so in-flight confirm loss almost never shows up in restart tests (E1: 0 rejections even at 5,000 msg/s). `docker pause` (E2) and `docker kill -s KILL` were needed to exercise those paths.
7. **Rejected ≠ not delivered** (verified T4: 1; E2: 20). The outbox will produce duplicates in exactly these cases, which is why consumer idempotency is mandatory (T5: 2 duplicates; T6: 1).
8. amqplib 2.x itself now has built-in connection recovery (`connectWithRecoveryPromise`, since 1.1.0). It could replace amqp-connection-manager entirely; not evaluated.
9. RabbitMQ 4.4's management API shows a `delayed_retry` field on quorum queues (`disabled` here). There may be a native delayed-retry feature that could replace TTL retry queues; not investigated.
10. Tooling: `tsx`/esbuild would drop decorator metadata. `tsc` + `node` worked first time. `timeout(1)` doesn't exist on macOS (irrelevant to the code).

## Verified vs inferred

- **Verified by running:** T1 to T6, T4-kill, T3b, E1, E2 (T1, T2, T3 and T6 rerun green on the final build); nack vs reject behaviour; broker restart and consumer crash both raising `x-delivery-count`; `mandatory` + `basic.return` turning an unroutable publish into a reject; at-least-once vs at-most-once vs the silent fallback; unroutable → reject; buffering and rejection behaviour of acm's built-in publish; the broker log warning; amqp-connection-manager 5.0.1 working with amqplib 2.3.1; Nest 12.5.0 DI with tsc decorator metadata.
- **Inferred (code reading or docs, not provoked):** the exact callback-ordering reason why acm rejects in-flight messages; `ChannelWrapper.ack()` on a stale tag closing the new channel; channel-only errors not being recovered until a connection reconnect; the 406-on-argument-change startup hang; the `returned` Set leak; TS 7 support for decorator metadata (not tried); the `delayed_retry` feature.

## Subjective: how easy is it to point out each guarantee in an interview?

Very easy. Every guarantee is a line or two in about 200 lines of our own code, with nothing hidden behind decorators or library config. "Resolve only in the confirm callback" is literally `settle()` inside amqplib's callback (`confirm-publisher.ts:82`). "Ack after commit" is `await handler(...)` followed by `ch.ack(msg)` (`document-consumer.ts:49-58`). DLQ, retry and the at-least-once DLX are one readable `assertTopology` function. The cost is that you also have to own and explain the subtle parts (reject vs nack, mandatory/return, ack on the right channel, fail-fast instead of buffering), because no library makes those choices for you. In an interview that is arguably a plus: each of those is a concrete "here is the failure mode, here is the line that handles it" story, and T1 to T6 back each one with numbers.
