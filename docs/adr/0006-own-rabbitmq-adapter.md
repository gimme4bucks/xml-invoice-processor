# 0006. Own RabbitMQ adapter on amqplib and amqp-connection-manager

Status: Accepted (2026-11-12)

## Context

The worker consumes from RabbitMQ, and the outbox relay publishes to it ([ADR 0004](0004-transactional-outbox-and-idempotent-consumer.md)). We need:

- publisher confirms;
- quorum queues with a delivery limit and dead-lettering;
- TTL retry queues;
- ack only after the database commit;
- automatic reconnects.

We rejected `@nestjs/microservices` (the RMQ transport) up front. It wraps messages in its own envelope and gives little control over confirms, quorum queues and DLX.

That left two options: `@golevelup/nestjs-rabbitmq` 9.1.2, or an adapter of our own. The developer preferred our own adapter, but doubted it would be more reliable than a library. So we ran two spikes in parallel, each against its own RabbitMQ 4.4.0 broker, with the same spec and the same tests, T1 to T6: confirms, TTL retry, poison message → DLQ, broker restart while publishing, broker restart while consuming, and a crash between commit and ack.

golevelup is itself built on amqplib and amqp-connection-manager. So the real difference is who owns the ack, nack and confirm behaviour: the library's defaults, or our own code.

## Decision

We build our own adapter on `amqplib` 2.3.1 and `amqp-connection-manager` 5.0.1, starting from the spike 02b code.

- **Reject, not nack.**
  - On RabbitMQ 4.4 quorum queues, `basic.nack(requeue=true)` does not count toward `x-delivery-limit`, while `basic.reject(requeue=true)` does.
  - So a failed handler calls `reject`.
- **`mandatory` publishing.**
  - A broker confirm does not mean the message was routed: an unroutable message is acked and then dropped.
  - With `mandatory: true`, a `basic.return` turns the publish into a rejection.
- **Fail-fast publisher, because the outbox is the buffer.**
  - We do not use amqp-connection-manager's in-memory publish buffer. The outbox is already the durable buffer, and the relay is already the retry loop.
  - With no live channel, a publish is rejected immediately.
  - A publish resolves only inside the confirm callback.
  - A confirm that has not arrived within 5 s means a rejection. Without a timeout, a publish can hang for as long as the outage lasts.
- **"Rejected means unknown", not "not delivered".** The relay leaves the row unpublished and publishes it again later, and the consumer is idempotent.
- **Delivery limit of 5–10.**
  - Broker restarts and consumer crashes also raise `x-delivery-count`, so a low limit would dead-letter healthy messages.
  - The limit only protects against poison messages. Our own retry count lives in the outbox and the aggregate.
  - Messages in the DLQ must be replayable.
- **At-least-once dead-lettering with reject-publish.**
  - We set `x-dead-letter-strategy: at-least-once` together with `x-overflow: reject-publish`.
  - Without `reject-publish`, RabbitMQ silently falls back to at-most-once.
- **Ack on the channel the delivery came from**, not through `ChannelWrapper.ack()`, which acks on whatever channel is current after a reconnect.
- **Fail fast on an unexpected channel close or consumer cancel.** The process stops and the restart policy starts the worker again, because amqp-connection-manager does not recover from channel-level errors.

## Alternatives considered

- **`@golevelup/nestjs-rabbitmq` 9.1.2.** It also passed T1 to T6 with no confirmed messages lost, with less code (181 lines in 4 files) and a declarative topology. Its drawbacks:
  - Confirms, reconnects and ack behaviour sit two packages deep.
  - The per-message publish timeout needs an untyped option, which means a cast.
  - Its default error handler uses `nack`, which silently defeats the delivery limit on RabbitMQ 4.4.
  - It offers no hook between "handler resolved" and "ack".
  - Its static state allows only one Nest app per process.
- **`@nestjs/microservices`.** See Context.
- **Not evaluated:**
  - amqplib 2.x's built-in connection recovery, instead of amqp-connection-manager;
  - RabbitMQ 4.4's `delayed_retry` on quorum queues, instead of TTL retry queues.

## Consequences

- **Size and visibility.** The adapter is somewhat more code: 273 lines in 5 files, or about 202 without blank lines and comments. In return, every guarantee is a visible line in our own code.
- **Ownership.** We own the subtle parts ourselves (reject vs nack, mandatory and return, which channel to ack on, failing fast) instead of relying on defaults.
- **Queue changes.** Changing the arguments of an existing queue, such as its delivery limit, causes a 406. It needs a new queue name or a policy.

## Evidence

Spikes [02a](../spikes/02a-rabbitmq-golevelup.md) and [02b](../spikes/02b-rabbitmq-amqplib.md): both pass T1 to T6, with 0 confirmed messages lost.

- **Nack vs reject.**
  - With `nack`, a poison message was redelivered about 24k times in 30 s (02a) and 23,771 times in about 20 s (02b), and never reached the DLQ.
  - With `reject`, it reached the DLQ after 4 deliveries.
- **Mandatory.** An unroutable publish was rejected instead of resolved (02b, T1).
- **Rejected but delivered.** 1 of 105 (02b, T4) and 20 of 20 (02b, E2).
- **Dead-lettering into an unbound exchange.** Only the queue with at-least-once and reject-publish kept the message (02b, T3b). It was delivered once the DLQ was bound, after 173.8 s, because of the broker's 180 s retry timer.
- **Broker killed during publishing.** 423 confirmed, 77 rejected, 0 confirmed messages lost (02b, T4 kill variant).
- **Restarts count.** After a broker restart during consuming, in-flight messages came back with `x-delivery-count: 1` (T5).

## Follow-ups

- Evaluate amqplib's built-in recovery, and RabbitMQ's `delayed_retry`.
- Delivery limit: 10 (broker restarts and crashes also count, see spike 02b).
- Replaying messages from the DLQ (e.g. a shovel or an admin command) is not built; it is a follow-up.
- Optional chaos tests (`pnpm test:chaos`).
