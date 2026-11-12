# AI usage

This document describes how I used AI to build this service:

- which tools I used, and for what;
- what I changed or rejected;
- how I checked the output;
- how much time it took.

The reasoning behind each choice is in the [decision log](decision-log.md) and the [ADRs](adr/).

## Which AI tools I used

**Claude Code with Claude Opus 5.5**, used in three ways:

- **A coordinating session.** I worked through the design with this session in a planning session on 2026-11-12, from about 11:40 to 15:50. It:
  - kept the decision log as we went (in Dutch; now translated);
  - launched the spikes;
  - built the foundation phase, started and monitored the `/goal` sessions, reviewed and merged their pull requests, and wrote the documentation.
- **Subagents for the spikes.** Each spike wrote a report, which you can find in [spikes/](spikes/):
  - a validation spike (XSD and Schematron);
  - two RabbitMQ client spikes, which ran in parallel with the same spec and the same tests.

  One more subagent looked up in the Claude Code documentation how `/goal` works.

- **Claude Code `/goal` sessions, one per work package** (G01 to G07), for the implementation.
  - Each session runs in its own git worktree and branch, in auto mode.
  - At most three run at the same time.

**Codex.** I considered it, since I have a personal account, but it worked noticeably less well for me, so I stayed with Claude Code.

## What I used AI for

**Planning and design.**

- Structuring the planning session into seven steps: framing, context, architecture, security, tooling, publication, and way of working.
- Working out the consequences of my choices. For example, what moving to Peppol meant for schemas, rules, and the purchase/sales distinction.
- Proposing patterns and their trade-offs: event sourcing, the outbox, idempotency, Problem Details, authentication.
- Looking up facts:
  - current package versions and npm dist-tags;
  - licences;
  - the Peppol release status;
  - how Claude Code's `/goal` behaves.

**Spikes.** Answering the risky questions with running code and measurements before committing to them:

- whether SaxonJS can run the official EN 16931 and Peppol rules in Node ([spike 01](spikes/01-validation.md));
- which RabbitMQ client approach gives the guarantees we need ([spike 02a](spikes/02a-rabbitmq-golevelup.md) and [spike 02b](spikes/02b-rabbitmq-amqplib.md)).

**Documentation.** Claude drafted the decision log, the ADRs and this file from my Dutch decision log and the spike reports.

- A subagent wrote the first ADR drafts. The coordinating session checked them against the decisions and corrected several, for example: NestJS decorators are allowed in the application layer (ADR 0010), the relay's polling interval (ADR 0004), the delivery limit of 10 (ADR 0006) and the S3 approach (ADR 0011).
- I read the drafts and had personal details removed before they went into the public repository.
- The README was written at the end, from the merged code and the ADRs.

**Implementation.** In three phases:

1. **Foundation** (the coordinating session): the monorepo, CI, the domain and the ports, in-memory adapters, a contract test suite per port, and a walking skeleton that proves the API and worker wiring end to end. `CLAUDE.md` holds the rules every later session follows.
2. **Work packages G01–G06** (`/goal` sessions, two waves of three in parallel). Each package has a goal file with owned paths, scope, acceptance criteria and a `/goal` condition ([docs/goals](goals/)). The coordinating session started each session headless in its own git worktree, watched its progress, and reviewed its pull request.
3. **Integration (G07)**: wiring the real adapters, the end-to-end tests against the full Docker Compose stack, and the demo.

The sessions never pushed to `main` or merged themselves. Every package arrived as a pull request that CI had to pass.

## AI output I changed or corrected

- **Invoice format.**
  - Claude proposed a simplified invoice XSD of our own.
  - I steered towards Peppol BIS Billing 3.0, which had come up in my earlier conversation with the CTO.
  - Claude then worked out what that meant: the UBL 2.1 XSDs, the official rule IDs, and deriving purchase vs sales from the token.
- **"An XSLT 2 engine is hard to run in Node."** That claim was too strong.
  - I asked about SaxonJS, which runs as a library in Node.
  - The result: the official EN 16931 and Peppol rules instead of a hand-coded subset ([ADR 0001](adr/0001-peppol-bis-billing-3-official-rules-saxonjs.md)).
- **Where the business rules run.**
  - Early on, I suggested running SaxonJS somewhere separate from the API. Claude answered that it could run in-process in the API. That was technically true, but it missed the point of keeping heavy computation out of the API.
  - Claude also assumed that running Schematron synchronously would cost no noticeable performance.
  - The spike proved that wrong for large invoices. The Peppol rules scale roughly quadratically: 9.9 s for an 800-line invoice. The synchronous transform also blocks the event loop.
  - We split validation: XSD synchronously in the API, and the rules asynchronously in the worker ([ADR 0002](adr/0002-split-validation-xsd-sync-schematron-async.md)).
- **Credit note amounts.**
  - Claude said a credit note has negative amounts.
  - In UBL/Peppol a `CreditNote` normally has positive amounts; the document type itself signals the credit.
- **Purchase vs sales invoices.**
  - Telling them apart was my requirement.
  - Claude pointed out that this is the submitting organisation's point of view, not a property of the document. That led to deriving it from the Peppol ID in the token ([ADR 0008](adr/0008-oauth2-client-credentials-and-organisation-scoping.md)).
- **Idempotency.**
  - Claude proposed the `Idempotency-Key` design.
  - I added a content-hash check across keys, so a byte-identical file is caught even under a new key ([ADR 0007](adr/0007-idempotency-key-and-content-hash.md)).
- **Error responses.**
  - Clear 4xx errors were my requirement.
  - Claude proposed RFC 9457 Problem Details as the format ([ADR 0012](adr/0012-problem-details-and-json-responses.md)).
- **RabbitMQ requeue behaviour.**
  - The spike brief asked for `nack` with requeue, so that the delivery limit would count failures.
  - The first spike measured that on RabbitMQ 4.4, nack does not count: a poison message was redelivered about 24k times in 30 s. The second spike confirmed it.
  - We use `reject` instead ([ADR 0006](adr/0006-own-rabbitmq-adapter.md)).
- **Event store.**
  - I asked for a dedicated event store (KurrentDB) to be analyzed seriously and documented, not just dismissed.
  - That analysis, including when it would become the right choice, is in [ADR 0003](adr/0003-event-sourcing-in-postgresql.md).
- **Integration risk.**
  - I was worried that wiring the parallel work together would not go smoothly.
  - We added contract tests per port and a walking skeleton to the foundation phase.
- **A bug in the foundation, found by a work package.** The coordinating session's first version restarted a processing attempt when a message was redelivered after a transient failure, which multiplied the retries. The G01 session found it while writing the crash tests and fixed it: the aggregate now knows whether an attempt is in progress (`attemptInProgress`).
- **Requeue during an outage (found in review).** The G04 consumer requeued a failed message immediately. During a database outage, a healthy message would then use up its 10 deliveries within milliseconds and land in the dead-letter queue. The coordinating session added a backoff before the requeue (1 s, doubling, at most 30 s).
- **Postgres down meant 500, not 503.** The HTTP package (G05) could not map a database outage, because the ports had no error type for it. Review turned this into an explicit task for G07: a `PersistenceUnavailableError` that the API maps to `503` with `Retry-After`.
- **Choices by the agents that were kept after review**, because they were better than the brief:
  - G05: an unreachable identity provider gives `503`, not `401`, so clients retry instead of assuming their credentials are wrong; and the body is read only after authentication.
  - G02: a business-rule timeout fails the document permanently instead of retrying, since the same document would time out again.
  - G06: the e2e runs used their own Compose project name, so they could not stop the infrastructure that the other sessions were using.
  - G07: no pg `query_timeout`. The session found that when it fires on a transaction's `ROLLBACK`, Prisma still returns the connection to the pool, so a later transaction could commit abandoned writes. It bounded the waiting with a connect timeout, Prisma's transaction limits and an overall deadline instead.
- **"Nothing was stored" after a 503 was too strong.** G07's deadline stops waiting, but a write may still commit. The coordinating session changed the 503 description: the outcome is unknown, and a retry with the same key is safe either way.

## Suggestions I deliberately did not adopt

- **Dutch documentation with English code.** I chose English for everything: docs, code, commits and API messages.
- **Kysely (or Drizzle) for data access.** I chose Prisma, because it is the tool I know best and the fastest way for me to deliver. A Kysely adapter may follow as an experiment, to show the ports and adapters at work ([ADR 0009](adr/0009-data-access-with-prisma.md)).
- **A business-level duplicate check on invoice number, right away.** I deferred it, for three reasons:
  - In production, customers send these fields in different ways, so a field mapping has to come first.
  - The schema we validate against is our own assumption.
  - Building the mapping layer means making assumptions about a part of the system nobody asked for.
- **Running the business rules synchronously in the API.** Not adopted, after the spike (see above).
- **Branch protection on `main`.** Not set up: every session uses the same GitHub account, which is an admin, so it would enforce nothing. The rule "never push to `main`, never merge yourself" is in `CLAUDE.md`, and auto mode refused a force push that one session tried.
- **A cleaner way to load libxml2-wasm** (`module.ignoreDynamic` in the SWC config) was suggested by the G02 session but left for later; the current loader works and is tested, at the cost of one `ExperimentalWarning` at startup.

## How I verified AI output

**Spikes with measurements, before committing to risky choices.**

- **Validation (spike 01).**
  - The official unit-test suites ran against our setup: CEN 1133/1133 and Peppol 686/687. The single failure is a known SaxonJS bug, which is documented.
  - Timings were measured per line count, which is what overturned the "synchronous is fine" assumption.
- **RabbitMQ (spikes 02a and 02b).**
  - I did not take either answer on trust: the library approach and our own adapter were both built and tested against the same six tests, on real brokers.
  - The tests included broker restarts, SIGKILL, and a crash between commit and ack.
  - Both passed, with 0 confirmed messages lost. The choice was then about where the guarantees live, not about whether they hold.
- **Verified vs inferred.** Each spike report separates what was verified by running it from what was inferred.

**Version and supply-chain checks.**

- The npm dist-tags were checked before pinning. For example:
  - `prisma` `latest` was a release candidate (8.0.0-rc.33) while `@prisma/client` was 7.10.1;
  - `typescript@latest` is 7.0.2, and we pin 5.9.3.
- All versions are pinned exactly, with no release candidates.
- A `minimumReleaseAge` of 3 days applies.
- Install scripts are blocked by default.

**Licences.** These were read in the validation spike (not legal advice) and handled conservatively:

- SaxonJS is a dependency only, never vendored;
- the Peppol rules are fetched at build time with a sha256 check.

**`/goal` conditions.**

- The goal check in Claude Code is done by a small model that sees only the transcript. It runs no commands and reads no files.
- So each condition requires:
  - the output and exit codes of the verification commands to appear in the transcript;
  - a scope check (`git diff --stat main`);
  - a turn limit.
- That verdict is not the gate. **CI on the PR plus human review is the hard gate.**

**Four layers of control for each work package:**

1. the agent, through `/goal`;
2. CI on the PR;
3. the coordinating session, which reviews against the decision log and the architecture rules;
4. my own final look before merging.

**Mechanical guardrails.**

- The architecture rules are enforced by dependency-cruiser in CI.
- Contract tests run the same suite against the fakes and the real adapters.
- Crash scenarios have their own tests.

**Agent containment.**

- The spikes ran in a scratch directory outside the repository.
- One spike agent still created three test files in the project folder because of a missing `cd`, and deleted them straight away.
- A check afterwards found the folder empty and `git status` clean.

**What actually caught problems during the implementation:**

- **The agents' own tests** caught the foundation bug above (G01).
- **Review by the coordinating session** caught the requeue gap (G04) and the missing 503 (G05), and checked every PR's diff against its owned paths and the shared contracts.
- **CI** ran on every pull request against the merge with `main`. A locally green `pnpm verify` after each merge confirmed the integration.
- **The usage limit** of the account stopped the second wave halfway through. Because every session works in its own worktree, nothing was lost: the sessions were resumed with their own context (`claude --resume`) and finished their work. Lesson: three parallel sessions use up a usage limit quickly.

- **Running it as a newcomer would.** After the last merge, the coordinating session rebuilt the stack from `main` and ran `pnpm demo`. It failed: an `.env` copied from an older `.env.example` set `ADAPTERS=in-memory`, so the API and the worker each had their own memory and no document was ever processed. The Compose stack now always uses the real adapters. All tests had been green; only running it end to end, the way a reviewer would, showed it.
- **The first release run** on `main` failed: the download pattern for the service image's digests also matched the mock IdP's. Fixed in a follow-up PR; the next run published both images.

During the implementation I delegated layer 4, the merge decision, to the coordinating session: it merged after its review and a green CI.

**The `/goal` sessions in numbers.** Wall-clock time and turns per session, and the cost Claude Code reports (the API list-price equivalent; the sessions ran under a subscription). G02, G05 and G06 were interrupted by the usage limit and resumed, so they count two runs.

| Work package               | Time                               | Turns | Reported cost |
| -------------------------- | ---------------------------------- | ----- | ------------- |
| G01 domain and application | 15 min                             | 45    | $4.58         |
| G02 validation             | 22 min                             | 99    | $11.13        |
| G03 persistence            | 12 min                             | 43    | $3.26         |
| G04 messaging              | 12 min                             | 48    | $3.62         |
| G05 HTTP and security      | 18 min                             | 68    | $9.41         |
| G06 delivery               | 28 min                             | 97    | $8.33         |
| G07 integration and e2e    | 32 min                             | 123   | $10.04        |
| **Total**                  | 2 h 19 min (at most 3 in parallel) | 523   | $50.37        |

## Time spent

The planning numbers come from the session log; times are approximate. "Agent time" is the wall-clock time of agents working in the background, in parallel with me.

| Phase                                       | My own time                | Agent time                                                                                              | Notes                                                                |
| ------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Preparation, before the planning session    | ~1.5 h                     | –                                                                                                       |                                                                      |
| Planning session (2026-11-12, ~11:40–15:50) | ~4 h 10 min                | –                                                                                                       | Interactive, with the coordinating Claude Code session               |
| Spike 01: validation                        | –                          | ~40–45 min (14:05 to ~14:45)                                                                            | Background subagent, during the planning session                     |
| Spike 02a: `@golevelup/nestjs-rabbitmq`     | –                          | ~40 min (~15:00 to ~15:40)                                                                              | Ran in parallel with 02b                                             |
| Spike 02b: own adapter (amqplib)            | –                          | ~1 h (~15:00 to ~16:00)                                                                                 | Ran in parallel with 02a                                             |
| Phase 1: foundation                         | check-ins                  | ~50 min (~15:50 to ~16:40)                                                                              | Coordinating session                                                 |
| Phase 2: work packages G01–G06              | check-ins                  | ~50 min (~16:44 to ~17:35)                                                                              | `/goal` sessions, at most 3 in parallel; includes a usage-limit stop |
| Phase 3: integration (G07)                  | –                          | ~32 min (~17:34 to ~18:06)                                                                              | One `/goal` session                                                  |
| Reviews, fixes and documentation            | check-ins                  | ~1 h 30 min (~17:00 to ~18:30)                                                                          | Coordinating session, in parallel with phases 2 and 3                |
| **Total**                                   | ~5 h 40 min plus check-ins | ~2 h 40 min of wall-clock time after the planning session (~15:50 to ~18:30), plus the spikes during it | One working day from preparation to release                          |
