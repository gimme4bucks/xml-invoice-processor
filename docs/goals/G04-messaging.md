# G04: Messaging (RabbitMQ)

**Goal:** the RabbitMQ adapters (publisher, consumer, topology) and the outbox relay, proven
against a real broker with the same contract as the in-memory broker.

## Context

- Read `CLAUDE.md`, ADRs 0004 and 0006, and `docs/spikes/02b-rabbitmq-amqplib.md`.
- Start from the spike code in `docs/spikes/code/02b-rabbitmq-amqplib/src/amqp/`.
- The contract: `apps/service/test/contracts/message-publisher.contract.ts`.

## Owned paths

- `apps/service/src/documents/adapters/outbound/rabbitmq/**` (new)
- `apps/service/src/documents/adapters/inbound/messaging/**`
- `apps/service/src/documents/application/relay/**`
- `apps/service/test/contract/rabbitmq.contract.spec.ts` (new)
- `apps/service/test/unit/relay*.spec.ts` (new)

## Scope

1. **Connection.** Use amqp-connection-manager with `AMQP_URL`. Every exchange and queue name gets a configurable prefix (`AMQP_PREFIX`, default empty), so tests run isolated on the shared broker.
2. **Topology, declared on every (re)connect:**
   - exchange `documents` (direct, durable);
   - quorum queue `documents.process` with `x-delivery-limit: 10`, `x-dead-letter-strategy: at-least-once`, `x-overflow: reject-publish`, dead-lettering to `documents.dlx`, which feeds quorum queue `documents.dlq`;
   - retry queues `documents.retry.5s`, `documents.retry.30s`, `documents.retry.2m`. They are bound with routing keys `retry.5s`, `retry.30s`, `retry.2m`, have a TTL, and dead-letter back to `documents` with routing key `process`;
   - TTLs come from config (`RETRY_DELAYS_MS`) so demos and tests can use short ones.
3. **`RabbitMqPublisher implements MessagePublisher`.** It publishes on a confirm channel with `mandatory: true`, handles `basic.return` and has a 5 s confirm timeout. It fails fast when not connected. It only resolves inside the confirm callback; otherwise it throws `PublishFailedError`.
4. **`RabbitMqDocumentConsumer`** (inbound):
   - consumes `documents.process` with a configurable prefetch and dispatches `ProcessDocumentCommand` via the `CommandBus`;
   - acks only after the handler resolved, on the delivery's own channel;
   - when the handler throws, uses `reject(msg, true)`, never `nack`;
   - on an unexpected channel close or consumer cancel: log, then exit the process (fail fast; the restart policy restarts it).
5. **Relay:**
   - keep `OutboxRelay` and `RelayLoop` (backoff when idle or failing);
   - add a deterministic test: if publishing succeeds but marking the row fails, the message is published again, and the consumer side processes it once. Use the in-memory adapters plus fault injection.
6. **Export:**
   - `rabbitMqProviders(): Provider[]` (publisher + connection);
   - `messagingConsumers` (consumer provider).

   G07 wires them into the composition root and `WorkerModule`; do not edit `src/app/*`.

7. **`test/contract/rabbitmq.contract.spec.ts`:**
   - runs `describeMessagePublisherContract('rabbitmq', …)` with a random prefix and short retry TTLs;
   - `simulateOutage` uses a publisher pointed at a closed port (it must reject fast);
   - add a consumer test proving `reject` makes a poison message reach the DLQ after the delivery limit.

## Out of scope

Persistence adapters, HTTP, the composition root. Chaos tests with `docker pause`/`kill` are optional (weekend).

## Acceptance criteria

- With `pnpm infra:up` running, `pnpm test:contract` passes the messaging contract and the DLQ test against RabbitMQ (show the output).
- `pnpm verify` exits 0.
- Only owned paths changed.
- A PR is open (`feat(messaging): …`).

## /goal condition

```
/goal Work package G04 in docs/goals/G04-messaging.md is done: RabbitMQ topology, confirm publisher (mandatory, timeout, fail fast) and consumer (ack after handler, reject not nack, fail fast) exist with exported rabbitMqProviders() and messagingConsumers; the relay re-publish test passes; with infra up you ran `pnpm test:contract` and the output shows the messaging contract and the poison-to-DLQ test passing against RabbitMQ (show it); you ran `pnpm verify` and it exited 0 (show the tail); `git diff --stat origin/main...HEAD` (shown) touches only the owned paths; and you opened a PR to main with `gh pr create` (show the URL). Follow CLAUDE.md, do not add dependencies. Or stop after 60 turns and report what is missing.
```
