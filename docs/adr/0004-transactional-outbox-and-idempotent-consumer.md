# 0004. Transactional outbox and idempotent consumer

Status: Accepted (2026-11-12)

## Context

The developer's requirement: once a document passes intake validation, it must be stored and its event published, and this must not fail. Storing in PostgreSQL and publishing to RabbitMQ involve two systems, so doing both directly is a dual write.

The developer felt the pattern should be called an "inbox", because we are the ones receiving the document. **Inbox and outbox are the same principle, applied at different boundaries:**

- For the document, we are the receiver. We store it durably first, and only then answer 202. That is the inbox idea.
- For the events, we are the producer. We write them to an outbox in the same transaction and publish them afterwards. That is the outbox idea.

## Decision

- **Separate outbox table.** It is written in the same transaction as the event and refers to it.
  - This corrects our first proposal, which used the event table itself as the outbox.
  - Events are immutable, so they get no "published" flag.
  - Reading events by sequence number has a trap: a transaction that commits later but holds a lower number gets skipped.
- **Relay, in the worker.**
  - It claims rows with `FOR UPDATE SKIP LOCKED`, so running several relays is safe.
  - It marks a row as published only after the publisher confirm ([ADR 0006](0006-own-rabbitmq-adapter.md)).
- **Only the relay talks to RabbitMQ.**
  - Anything that wants to publish, retries included, writes an outbox row in the same transaction.
  - The API process does not connect to RabbitMQ.
- **Retries.**
  - There is one queue per delay (for example 5 s, 30 s and 2 min, configurable for the demo). Each has a TTL and dead-letters back to `documents.process`.
  - After the maximum number of attempts, the aggregate records `DocumentProcessingFailed` and the document goes to `Failed`.
- **Idempotent consumer, no inbox table.**
  - The document status and the unique `(stream_id, version)` absorb duplicates, including duplicates that arrive at the same time.
  - An inbox table only becomes necessary for side effects the aggregate does not guard, such as email or payments. The VIES check is only a lookup.

**The exact guarantee:**

- **Storing is atomic.** The event, status row, outbox row, idempotency key and XML are written in one transaction.
- **Publishing is guaranteed, but may happen later.** If RabbitMQ is down, the API still accepts the document (202), and the relay publishes once RabbitMQ is back.
- If PostgreSQL is down, the API answers 503, and the client can safely retry with the same `Idempotency-Key` ([ADR 0007](0007-idempotency-key-and-content-hash.md)).

## Alternatives considered

- **The event table as the outbox** (our first proposal). Rejected for the two reasons above.
- **An inbox table for deduplication.** Not needed while the aggregate guards every side effect.

## Consequences

- Delivery is at-least-once, so duplicates will happen and the consumer must be idempotent.
- We add an outbox table and a polling relay. How quickly events are published depends on the relay's polling interval: immediately again while there is work, every 200 ms when idle, and after 1 s when publishing failed.
- The API does not depend on RabbitMQ.
- Crash scenarios are tested at three levels: deterministic fault injection (for example, the relay crashes after publishing but before marking the row), contract tests against a real database, and e2e tests on real infrastructure (RabbitMQ or PostgreSQL down during submission). The full list is in the [decision log, 7.8](../decision-log.md).

## Evidence

Spikes [02a](../spikes/02a-rabbitmq-golevelup.md) and [02b](../spikes/02b-rabbitmq-amqplib.md) show why the consumer must be idempotent:

- A publish that was rejected may still have been delivered. In 02a this happened 10–14 times per outage; in 02b, 1 of 105 times in T4 and 20 of 20 in E2. The relay publishes these again, which creates duplicates.
- A broker restart during processing redelivers the messages in flight: 2 duplicate commits in T5. A crash between commit and ack redelivers the message: T6.
- Duplicates can arrive concurrently, through an ack on a dead channel after a reconnect (02a; inferred, not observed).
- In both spikes, no message that the broker had confirmed was ever lost.

## Follow-ups

- Add an inbox table once processing has side effects outside the aggregate (email, payments, webhooks).
- Optional chaos tests (`pnpm test:chaos`) that pause or kill the broker.
