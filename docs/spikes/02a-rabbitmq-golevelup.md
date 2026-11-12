> The spike code is copied to [`code/`](code/) (without dependencies and downloads); `<scratch>` paths below refer to the original local scratch directory.

# Spike 02a: RabbitMQ worker with @golevelup/nestjs-rabbitmq

Code: `<scratch>/spike-rabbitmq-golevelup`
Broker: own container `spike-rmq-a` (`rabbitmq:4-management-alpine` = **RabbitMQ 4.4.0**, Erlang 29.1.2), ports 5673/15673. The container has been removed.
Run: `npx tsc -p tsconfig.json && node dist/tests/t1.js` (up to t7; `RESTART_MODE=restart|stop8|kill8` for T4/T5).

Legend: **[V]** verified by running it. **[C]** read in the library source (not run on its own). **[I]** inferred.

## TL;DR

- All 6 tests pass. Every guarantee could be built with the library's own config, `@RabbitSubscribe` and `AmqpConnection.publish`, without bypassing the library. I had to add one override and one test-only monkeypatch:
  1. **Override (key finding, applies to both approaches):** on RabbitMQ 4.4, `basic.nack(requeue=true)` does **not** count toward `x-delivery-limit` on a quorum queue. A poison message was redelivered roughly 24k times in 30 s and never reached the DLQ [V]. `basic.reject(requeue=true)` and channel close do count [V]. The library's built-in `requeueErrorHandler` and its `Nack` response both use `nack`, so I wrote a 3-line `errorHandler` that calls `channel.reject(msg, true)`. The spec's "nack with requeue so the delivery limit counts it" is wrong for this broker version, so the other approach must use `reject` too.
  2. **Test-only:** T6 patches `channel.ack` on the consumer's raw amqplib channel, because the library offers no hook between "handler resolved" and "ack".
- `publish` waits for broker confirms by default: golevelup creates every channel through amqp-connection-manager, whose ChannelWrapper uses `confirm: true` by default [C][V]. A rejection on timeout needs the per-message `timeout` option. Neither golevelup's types nor its module config expose it [C].
- On reconnect the library re-runs topology and consumers by itself [V]. Publishes queued while the broker is down wait for the reconnect, or reject on `timeout` [V].

## Test results (all [V], final code)

| Test | Result | Numbers |
|---|---|---|
| T1 | PASS | 200 published, 200 confirmed (in 12 ms), 200 consumed, 0 duplicates |
| T1a (extra) nack | PASS | 1st message on a max-length-1 + reject-publish queue resolved; 2nd **rejected: "message nacked"** |
| T1b (extra) unroutable | informational | publish with an unbound routing key **resolved**: a confirm does not mean the message was routed (see gotchas) |
| T2 | PASS | retry.1s arrived after **1017 ms** (x-death `documents.retry.1s:expired:1`); retry.3s after **3010–3012 ms** |
| T3 | PASS | poison delivered **4×**, `x-delivery-count` seen by the handler: **[absent, 1, 2, 3]**, redelivered flags [false, true, true, true]. In the DLQ: `x-first-death-reason=delivery_limit`, `x-delivery-count=4`, x-death count 1. 10/10 good messages consumed, 0 duplicates, process queue empty |
| T4 `docker restart` (outage 3.0–4.0 s) | PASS | 500 published / **500 confirmed / 0 rejected / 500 consumed / 0 lost-confirmed**, 0 duplicates. Every publish queued during the outage was sent after the reconnect, within the 5 s timeout |
| T4 `docker stop`, 8 s down, start (outage 11.0 s) | PASS | **198 confirmed / 302 rejected** (302 `timeout`) / 212 consumed / **0 lost-confirmed** / 14 rejected-but-actually-delivered |
| T4 `docker kill` (SIGKILL), 8 s down, start (outage 11.1 s) | PASS | **200 confirmed / 300 rejected** (299 `timeout`, 1 `channel closed`) / 210 consumed / **0 lost-confirmed** / 10 rejected-but-delivered |
| T5 `docker restart` (outage 3.0 s) | PASS | 20/20 consumed in the same process. **2 redeliveries** (the 2 in-flight messages, `x-delivery-count=1`), 22 handler completions, so 2 duplicate commits. First delivery came ~2.8 s after the restart command returned. Queue empty at the end |
| T5 stop 8 s (outage 11.0 s) | PASS | 20/20, 2 redeliveries (dc=1), 2 duplicate completions, queue empty |
| T6 | PASS | child 1 committed `t6-…` (redelivered=false, dc=0) and was SIGKILLed before the ack. Child 2 got the **same messageId again** (redelivered=true, `x-delivery-count=1`) and committed it a second time. **1 duplicate**, queue empty |
| T7 (extra) channel error | informational | `amqp.publish('no-such-exchange')` caused a 404 channel close and was **rejected "channel closed"**. amqp-connection-manager then **dropped and re-established the whole connection** (logged "Disconnected…"). The next publish resolved after 519 ms; the consumer kept working |

"Rejected-but-delivered" (T4) covers messages whose `timeout` fired while they were already sent, or the one that got `channel closed` after the broker had already stored it. The relay leaves those outbox rows unpublished and publishes them again, which produces duplicates. That is acceptable, because the consumer is idempotent; this is the at-least-once trade-off.

Not re-run after the last harness fix: T5 with `kill8`. The earlier run had the same functional numbers (20/20 unique, 2 redeliveries with dc=1). It failed only because the management API reported a stale queue depth. I replaced that check with polling `rabbitmqctl` and re-ran T5 with `restart` and `stop8`.

## Dead-letter strategy at-least-once [V]
Configured purely through the library's queue `options.arguments`: `x-dead-letter-strategy: at-least-once` + `x-overflow: reject-publish` (topology.ts:21, :50, :64). The management API shows the arguments on the queues. The broker's Prometheus counters confirm the strategy is active and not silently downgraded:
`messages_dead_lettered_delivery_limit_total{dead_letter_strategy="at_least_once"}` and `..._expired_total{at_least_once}` (retry queues) go up, the `at_most_once` counters stay at 0, and `messages_dead_lettered_confirmed_total{at_least_once}` goes up as well. I used at-least-once on the retry queues too, so the hop back to `documents` can't lose a message either.

## Answers to the approach-specific questions

**Does `publish` wait for confirms?** Yes [C][V].
- `AmqpConnection.publish` (golevelup `lib/amqp/connection.js:609-624`) returns `this._managedChannel.publish(...)`.
- That channel is created with `createChannel({ name })` (connection.js:684). The ChannelWrapper default is `confirm: true` (amqp-connection-manager `ChannelWrapper.js:187`), so it is a ConfirmChannel.
- The promise resolves on basic.ack and rejects on nack ("message nacked") [V T1a].
- If the channel closes while a message is unconfirmed, amqplib calls the callback with "channel closed" (`amqplib/lib/channel.js:39-44`). The wrapper rejects the promise, because its `_channel` is still set at that moment (`ChannelWrapper.js:343`) [C]. Observed once in T4 kill8 [V].
- Messages not yet sent when the connection drops stay in the wrapper's queue and are sent after the reconnect [V T4 restart: 500/500].
- Without a `timeout` they wait **indefinitely**. The `timeout` option is read by `ChannelWrapper.publish` (`ChannelWrapper.js:87-101, 119-137`). It is not in golevelup's typed `Options.Publish`, so it needs a cast (publisher.ts:32). It is also not settable as `publishTimeout` per channel, because golevelup only passes `{ name }` to `createChannel`.
- A timed-out message is removed from the send queue, so it is never sent later [C]. It is still counted as rejected if it was already on the wire [V T4: rejected-but-delivered].

**Default error / ack / requeue behaviour** [C] (`connection.js:27-52, 298-331`, `errorBehaviors.js`):
- Handler resolves → `channel.ack(msg)` right after `await handler(...)` (connection.js:307-317). That is exactly "ack after commit".
- Handler throws → `errorHandler`. The default is `defaultSubscribeErrorBehavior: REQUEUE`, which is `requeueErrorHandler` = `channel.nack(msg, false, true)`.
- Returning `new Nack(requeue)` also uses `nack`. A non-void return value is logged as a warning and then acked.
- JSON parse errors happen inside the same try, so they also go to the error handler.
- If the ack or nack itself throws (stale or closed channel after a reconnect), `wrapConsumer` (connection.js:286-297) logs "Unhandled error while processing message" and swallows it. The broker redelivers the message [V T5: 4× "IllegalOperationError: Channel closed" in the log, then redelivery].
- **Override:** `errorHandler: rejectRequeueErrorHandler` → `channel.reject(m, true)` (consumer.ts:26-28, :40), because of the RabbitMQ 4.4 nack/delivery-count behaviour [V via probe `probe/nack-probe.js`: nack → dc stays absent and only `x-acquired-count` grows 1..7, the message never dies; reject → dc 1, 2, 3, then the message is gone; channel close → dc 1, 2, 3, then the message is gone].

**How queue arguments are passed** [C][V]: `queues[].options` is handed unchanged to amqplib `assertQueue(name, options)` (connection.js:650-656). So quorum, delivery-limit, DLX and dead-letter strategy all go into `options.arguments` as raw `x-*` keys. There are no typed helpers. Exchanges work the same way, through `exchanges[].type/options`. Bindings come from `exchange` + `routingKey` on each queue entry.

**Reconnect and in-flight publishes** [C][V]:
- amqp-connection-manager reconnects after `reconnectTimeInSeconds` (1 s here; the default is equal to the heartbeat, 5 s). Settings: topology.ts:34.
- On every connect, the ChannelWrapper re-runs all `addSetup` functions (`ChannelWrapper.js:205-247`): golevelup's `setupInitChannel` (prefetch, exchanges, queues, bindings) and the consumer setup (`checkQueue` + `consume`). Then it flushes queued publishes.
- In-flight publishes: unconfirmed ones reject with "channel closed". Unsent ones wait and are sent after the reconnect, or reject with "timeout".
- In-flight **consumer** messages: their ack fails on the dead channel and the broker redelivers them with `x-delivery-count` +1 [V T5].

## Where each guarantee lives (adapter = 181 lines incl. comments, 136 non-blank non-comment, 4 files; tests/harness 483 lines)

| Guarantee | Adapter file:line | Library mechanism |
|---|---|---|
| Publisher confirms + reject on nack/timeout/loss | `src/messaging/publisher.ts:26-33` (persistent, messageId, JSON contentType, `timeout`) | implicit: golevelup `connection.js:624, 684` → amqp-connection-manager `ChannelWrapper.js:187` (confirm default) |
| Ack only after the handler/commit resolves | `src/messaging/consumer.ts:42-50` | implicit: golevelup `connection.js:307-317` |
| Requeue so the delivery limit counts it | `src/messaging/consumer.ts:26-28` (reject handler), `:40` (wired in) | overrides golevelup's `requeueErrorHandler` (nack) |
| DLQ (quorum, delivery-limit 3, at-least-once DLX) | `src/messaging/topology.ts:21, 40, 43, 50` | `queues[].options.arguments` → `assertQueue` |
| Retry queues (TTL → DLX back to `documents`/`process`) | `src/messaging/topology.ts:11-16, 53-67` | same |
| Prefetch 2 | `src/messaging/topology.ts:36` (named channel) + `consumer.ts:37` (`queueOptions.channel`) | `setupInitChannel` → `channel.prefetch` |
| Reconnect | `src/messaging/topology.ts:34` | implicit: amqp-connection-manager plus ChannelWrapper re-running setups |
| Topology at startup, idempotent | `src/messaging/topology.ts:23-69`, `worker.module.ts:19` (`RabbitMQModule.forRoot`) | `setupInitChannel` (connection.js:163-192) on every (re)connect of the default channel |

**Retry addressing choice:** the retry queues are bound to the same `documents` exchange with routing keys `retry.1s` and `retry.3s` (topology.ts:11-16). The publisher signature `publish(routingKey, …)` therefore stays unchanged: `publish('retry.1s', …)`. There is no extra exchange and no default-exchange trick. The DLX is a `fanout`, so every dead-lettered message lands in the DLQ whatever its routing key.

## Implicit vs overridden

Implicit (the library does it): ConfirmChannel; JSON serialize and deserialize; topology declaration on every reconnect; consumer re-subscription; ack after the handler resolves; graceful shutdown waits for outstanding handlers (`close()`, connection.js:758-776).

Overridden or set explicitly:
- `errorHandler` → `reject(requeue)`, the key override.
- `persistent` / `contentType` / `messageId` / `timeout` per publish. The defaults are non-persistent and have no timeout.
- `prefetchCount`: the library default is 10 on the default channel. I used a named consumer channel with 2.
- `enableDirectReplyTo: false`. The default is true, which adds an RPC reply consumer to the default channel.
- `defaultExchangeType` is `topic` by default, so I set `type: 'direct'` explicitly.
- `createQueueIfNotExists: false` on the subscriber, so the decorator only runs `checkQueue` and the queue arguments live in one place.
- `registerHandlers: false` for a publisher-only (relay) process.

## Gotchas / what didn't work
1. **RabbitMQ 4.4: nack(requeue) does not count toward the delivery limit** [V]. With the library defaults, a poison message loops forever (roughly 24k redeliveries in the 30 s the test waited, nothing in the DLQ). Fix: use `reject`. This is a broker gotcha that affects both approaches. I did not look up the release note that introduced it; the behaviour itself is verified.
2. **Broker restarts and consumer crashes count toward the delivery limit** [V T5/T6: dc=1 after a redelivery]. A healthy message can reach the DLQ after 3 crashes or restarts mid-processing. Pick the delivery limit with that in mind.
3. **Confirm ≠ routed** [V T1b]. An unroutable publish is acked and dropped. `mandatory: true` would only emit a `return` event that is not tied to the publish promise [I]. Mitigation: an alternate-exchange on `documents`, or a fixed set of routing keys.
4. **`timeout` is untyped and has no default.** Without it, a publish during a long outage stays pending forever, which can hang the relay. It is also not configurable through the module, because `createChannel` options are not exposed [C].
5. **Rejected does not mean not delivered** [V T4: 10–14 of about 300]. A timeout or "channel closed" can hit a message the broker already stored. The outbox design (relay publishes again, consumer is idempotent) covers this.
6. **One bad publish (for example to a missing exchange) reconnects the whole connection** [V T7]. Recovery is automatic, but the blast radius is every channel, so in-flight consumer acks fail and those messages are redelivered [I from T5's mechanics].
7. **Ack after a reconnect goes to the stale channel** [V T5 log]. The handler runs, and its ack fails with `IllegalOperationError: Channel closed`; the library only logs it. The broker has already redelivered, possibly *while the first handler is still running*, so two handlers may process the same message concurrently [I]. Idempotency has to handle concurrent duplicates (unique constraint or row lock), not only sequential ones.
8. **The library offers no hook between "handler resolved" and "ack".** T6 had to monkeypatch the raw channel's `ack` (`tests/t6-child.ts`). The test code is fine with this, but the library cannot express it.
9. **The management API's queue counters lag** a few seconds behind acks after a restart. I use `rabbitmqctl list_queues` (polled) for assertions.
10. **The library keeps static state** (`RabbitMQModule.connectionManager`, `bootstrapped`): only one Nest app per process [C].
11. **Toolchain:** NestJS 12 is ESM-only (`"type": "module"`). A CJS project with TS 5.9 `module: nodenext` works through Node 22's require(esm), and golevelup (CJS) loads it that way too [V]. `typescript@latest` is 7.0.2; I pinned 5.9.3 for proven `emitDecoratorMetadata` support [I: did not test TS 7]. Setting up transient (non-durable) queues failed on RabbitMQ 4.4: the deprecated `transient_nonexcl_queues` feature is refused (test fixture only).

## Exact pinned versions (installed with `--save-exact`; no rc/alpha/beta)
`@golevelup/nestjs-rabbitmq 9.1.2` (→ `amqplib 0.10.9`, `amqp-connection-manager 5.0.1`, `@golevelup/nestjs-discovery 7.1.0`, `lodash 4.18.1`), `@nestjs/core 12.5.0`, `@nestjs/common 12.5.0`, `reflect-metadata 0.2.2`, `rxjs 7.8.2`; dev: `typescript 5.9.3`, `@types/node 22.19.1`, `@types/amqplib 0.10.8`. Node 22.14.0. Broker RabbitMQ 4.4.0.

## Interview explainability (subjective)
- **Topology, DLQ, retry, prefetch:** very easy. It is one declarative config object (topology.ts) that maps 1:1 to the RabbitMQ concepts.
- **Ack after commit:** easy to show in the handler. To prove it you must point into the library (connection.js:317), because the "returning means ack" contract is implicit.
- **Confirms:** medium to hard. The guarantee sits two layers down: golevelup → amqp-connection-manager ChannelWrapper default `confirm: true`. The reject-on-timeout behaviour depends on an untyped `timeout` option, and the in-flight semantics (requeue-and-resend vs reject) live in ChannelWrapper internals. It works, but "where is the confirm?" can't be answered by pointing at our code.
- **Reconnect:** "the library does it" is true but opaque. Explaining *why* nothing is lost (setups re-run, stale-channel ack fails, broker redelivers) takes knowledge of three packages.
- **Poison/DLQ:** easy to point at, but it needs the reject-vs-nack footnote, which is a good interview story.

Overall: little code, and every guarantee is reachable through supported extension points. The weak spots are confirm/timeout semantics that stay implicit and an error-handling default (nack) that silently defeats the delivery limit on RabbitMQ 4.4.
