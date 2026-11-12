# 0005. No saga

Status: Accepted (2026-11-12)

## Context

Processing a document is linear and stays within one service:

1. rule validation;
2. the VIES check;
3. `Completed` or `Failed`, with retries on transient errors along the way.

Nothing has to be compensated. Even so, a saga or process manager is a common reflex in event-driven designs, and NestJS offers sagas in `@nestjs/cqrs`.

## Decision

- We use no saga and no process manager.
- Coordination (counting attempts, deciding to retry or give up) lives in the `Document` aggregate, as a state machine. "At most N attempts" is a domain rule.
- Anything that must not be lost goes through the outbox and RabbitMQ ([ADR 0004](0004-transactional-outbox-and-idempotent-consumer.md)), never through the in-memory event bus.

## Alternatives considered

- **`@nestjs/cqrs` sagas.** They run on the in-memory event bus. If the process crashes after the commit but before the saga dispatches its command, the command is lost. That is not acceptable for this flow.
- **A durable saga or process manager.** Today there is nothing to compensate and no other system to coordinate, so it would add concepts without any benefit.

## Consequences

- There are fewer moving parts, and the retry policy sits in the domain, where unit tests can cover it.
- From `@nestjs/cqrs` we use only `CommandBus` and `QueryBus` ([ADR 0010](0010-hexagonal-architecture-with-enforced-dependency-rules.md)).
- `CLAUDE.md` makes this an architecture rule: never use the in-memory event bus for critical paths.

## Evidence

n/a

## Follow-ups

- Introduce a saga or process manager once processing touches several systems with side effects (accounting, payments, webhooks).
