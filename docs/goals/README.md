# Work packages

The build was split into work packages that Claude Code sessions executed in parallel, each in
its own git worktree and branch, driven by a `/goal` condition. Every package has an owned set of
paths, verifiable acceptance criteria and a Definition of Done (see `CLAUDE.md`).

| Phase | Package                                               | Depends on | Runs alongside |
| ----- | ----------------------------------------------------- | ---------- | -------------- |
| 1     | Foundation (coordinator, no goal file)                | –          | –              |
| 2a    | [G01 Domain & application](G01-domain-application.md) | foundation | G03, G04       |
| 2a    | [G03 Persistence (Prisma)](G03-persistence.md)        | foundation | G01, G04       |
| 2a    | [G04 Messaging (RabbitMQ)](G04-messaging.md)          | foundation | G01, G03       |
| 2b    | [G02 Validation](G02-validation.md)                   | foundation | G05, G06       |
| 2b    | [G05 HTTP & security](G05-http-security.md)           | foundation | G02, G06       |
| 2b    | [G06 Delivery (Docker, CI/CD)](G06-delivery.md)       | foundation | G02, G05       |
| 3     | [G07 Integration & e2e](G07-integration.md)           | all above  | –              |
| 4a    | [G08 HTTPS at the edge](G08-https.md)                 | v1.0.0     | G09            |
| 4a    | [G09 Unhappy path operations](G09-unhappy-path.md)    | v1.0.0     | G08            |
| 4b    | [G10 Chaos tests](G10-chaos-tests.md)                 | G08, G09   | G11            |
| 4b    | [G11 Credit notes](G11-credit-notes.md)               | G08        | G10            |

Phase 4 (after v1.0.0) adds the extras. From G08 on, every package works test-first (red,
green, refactor; see `CLAUDE.md`).

The foundation fixes the contracts (ports, domain events, Prisma schema, contract test suites)
and a walking skeleton that already runs end to end on in-memory adapters. Each package replaces
stand-ins with real implementations behind the same contracts, so integration (G07) is mostly
wiring.

## How a package is run

1. The coordinator creates the worktree: `git worktree add ../xip-<id> -b goal/<id> origin/main`.
2. A Claude Code session is started in that worktree (auto mode) with the `/goal` condition from
   the package file.
3. The session opens a PR. CI plus a human review decide; the `/goal` evaluator only judges the
   transcript, so it is never the final gate.
