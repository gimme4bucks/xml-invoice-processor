# 0003. Event sourcing in PostgreSQL

Status: Accepted (2026-11-12)

## Context

Each document goes through a lifecycle: received, then processing with retries on transient errors, and finally `Completed` or `Failed`. We want:

- a history per document;
- an audit trail of who submitted what;
- optimistic concurrency between competing workers;
- reliable publication of what happened.

The load assumption is 1,000 documents per day for the whole system, with at most about 10 events per document.

The developer explicitly asked that a dedicated event store be seriously considered, and that the documentation show this.

## Decision

We use lightweight event sourcing on PostgreSQL, with a small implementation of our own behind an `EventStore` port.

- **Event table:** a unique `(stream_id, version)` gives optimistic concurrency.
- **Read model:** a status table, updated in the same transaction (an inline projection). Queries read the status table, never the aggregate.
- **No snapshots:** a stream has at most about 10 events.
- **Append-only:** enforced through database privileges. The app role has INSERT and SELECT only.
- **Audit and history:** who submitted what is kept in the event metadata. This makes a history endpoint per document possible.
- **One ACID transaction** covers:
  - the event;
  - the status row;
  - the outbox row ([ADR 0004](0004-transactional-outbox-and-idempotent-consumer.md));
  - the idempotency key ([ADR 0007](0007-idempotency-key-and-content-hash.md));
  - the XML ([ADR 0011](0011-document-storage-in-postgresql-behind-blobstore-port.md)).

## Alternatives considered

**State-based storage plus an outbox.**

- A plain status table with an outbox table would avoid the extra concepts listed under Consequences.
- Why event sourcing over state-based storage: a document's lifecycle is naturally a sequence of events; for invoices a complete history (which attempt failed, why, and who submitted it) is valuable and comes for free, including a history endpoint; event sourcing was named as important in the first conversation; and the extra cost in this small domain was estimated at under an hour.
- What event sourcing gives us here: the per-document history, the audit trail in event metadata, and optimistic concurrency via `(stream_id, version)`. The idempotent consumer relies on that concurrency check as well.

**KurrentDB (formerly EventStoreDB).**

- For:
  - It is built for event sourcing, with streams and optimistic concurrency.
  - Native (persistent) subscriptions mean we would not need a polling relay.
  - It has built-in projections and replays.
  - It could take over part of RabbitMQ's role.
  - Its Node client, `@kurrent/kurrentdb-client` 1.3.2, is Apache-2.0 licensed.
- Decisive against it, for now: we would lose the single ACID transaction over the event, the read model, the idempotency key and the stored XML. As a result:
  - the dual write comes back;
  - projections become eventually consistent;
  - idempotency has to be done differently.
- Also against:
  - extra infrastructure to operate, back up, secure and monitor, plus more memory;
  - overlap with RabbitMQ;
  - 1,000 documents per day does not call for it.
- It would become the right choice when we have:
  - many consumers or projections that want to subscribe to the event stream directly;
  - several services using the event stream as their backbone;
  - replays at scale;
  - event volumes where a polling relay becomes the bottleneck.
- Migration path: give the `EventStore` port a KurrentDB adapter. To be honest, that is not a pure swap: the atomicity assumption (inline projection, idempotency in the same transaction) changes with it.

**Emmett** (`@event-driven-io/emmett-postgresql` 0.42.x, still 0.x, actively developed).

- We weighed it against our own implementation. It means an extra dependency and a learning curve, while our own code is small and we can explain all of it.

## Consequences

- One transaction covers everything that must be stored together. A concurrency conflict shows up as a unique-index violation.
- There are more concepts than with plain CRUD storage: projections and rehydration.
- Ad-hoc queries go through the read model.
- In the long run, event versioning and upcasting become a concern.

## Evidence

n/a

## Follow-ups

- Revisit KurrentDB when one of the triggers above appears.
- Decide on an event versioning and upcasting strategy once event schemas need to change.
