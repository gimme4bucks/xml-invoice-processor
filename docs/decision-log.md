# Decision log

This is a cleaned-up English version of the decision log kept during the planning session on 2026-11-12, from about 11:40 to 15:50. In that session the developer and Claude (Claude Code, Claude Opus 5.5) worked through the design step by step before writing any code. The original log was in Dutch.

- The log follows the seven agenda steps. Within each step, entries keep the order in which they were made. All times are approximate.
- Each entry gives what was decided, why, and who drove it:
  - **Developer**: the developer's requirement, idea or choice.
  - **AI (Claude)**: proposed by Claude and accepted by the developer.
  - **Both**: worked out together, or the original log does not say who proposed it.
- Corrections are kept on purpose: places where Claude was wrong, or where the developer steered. There is a summary at the end, and more in [AI usage](ai-usage.md).
- The [ADRs](adr/) record the final form of the main decisions. The spike reports are in [spikes/](spikes/).

Agenda:

1. Framing: planning, deadline and level of ambition
2. Context: users, volumes and sizes, document type
3. Architecture: event sourcing, outbox/inbox, saga
4. Security: authentication and authorisation
5. Tooling: data access, build and test tooling, XSD and RabbitMQ libraries, frontend
6. Publication: GitHub account, public or private, artifacts
7. Way of working: language, goal format, AI log and ADRs, tests

## 1. Framing

**1.1 Timeline and ambition**. _Driven by: Developer_

- Plan: deliver the work to the reviewers a few days before the follow-up conversation, so they can review it in advance.
- Ambition: "done enough" and presentable at delivery, with time afterwards for finishing touches.

**1.2 Tag the delivered version**. _Driven by: Both_

- Decided: tag the version that is sent (semver, `v1.0.0`). Later improvements go on top as separate commits, and the email to the reviewers says so.
- Why: it keeps a clear line between what was delivered on time and what came after.

**1.3 Scope for today**. _Driven by: Both_

- Decided:
  - the five required features, end to end via Docker Compose;
  - authentication;
  - outbox, idempotent consumer, and retry/DLQ;
  - unit and e2e tests;
  - CI;
  - a README with an AI section;
  - GHCR images if time allows.

**1.4 Scope for the weekend**. _Driven by: Both_

- Decided:
  - a frontend;
  - richer logging and correlation IDs;
  - S3/MinIO;
  - a live demo;
  - extra crash-scenario tests;
  - preparation for a whiteboard discussion.

**1.5 Local development**. _Driven by: Both_

- A working local container setup is on the critical path, because agents cannot run tests without it.
- For local development, the API and the worker run natively on Node. Only PostgreSQL and RabbitMQ run in containers. Compose uses healthchecks and a restart policy, because a RabbitMQ container once exited right after its first start, with no visible cause.

## 2. Context

**2.1 Users**. _Driven by: Both_

- Decided: this is a B2B integration and fully automated, with systems talking to systems and no human interaction.
  - A "user" is an organisation, not a person. People may come later.
  - The expected user count (fewer than 10,000) is taken to mean at most that many submitting organisations or clients.
- Consequences:
  - Authentication is machine-to-machine: a client-credentials JWT whose claims carry the organisation ID and scopes.
  - Authorisation is per organisation, so each organisation sees only its own documents.
  - Clients get document status by polling the API. Webhooks and callbacks go into the README as a follow-up scenario.
  - The weekend frontend is an admin and support view, not something for customers.

**2.2 Volume**. _Driven by: Both_

- Decided: assume a load of 1,000 documents per day for the whole system in this concept.
- Production may see more. Scaling scenarios (S3, more workers) go into the README as next steps.

**2.3 Document type, first version (later replaced)**. _Driven by: AI (Claude)_

- The first decision was an invoice described by our own simplified XSD. Peppol replaced it (see 2.5).
- These parts carried over:
  - synchronous XSD validation that rejects a document immediately and returns the XSD errors;
  - asynchronous processing: convert XML to JSON and recompute the totals. A totals mismatch is a permanent error, so the document goes to `Failed` with a reason.
- Transient errors come from a VAT-number check against VIES. It sits behind a port, with a fake adapter that fails at a configurable rate. A retry can still end in `Completed`; once the maximum number of attempts is used up, the document goes to `Failed`.

**2.4 Purchase vs sales invoices**. _Driven by: Developer (requirement), AI (Claude) (analysis)_

- The developer required that invoice kinds be told apart, for example purchase vs sales invoices.
- Claude pointed out the following:
  - Purchase vs sales is the submitting organisation's point of view, not a property of the document.
  - A credit note, by contrast, _is_ a property of the document.
  - The kind decides the counterparty (purchase → supplier, sales → customer), and so whose VAT number goes to VIES.
  - So there is one strategy per kind (open/closed principle).
- This is settled in 2.6.

**2.5 Peppol BIS Billing 3.0**. _Driven by: Developer (choice), AI (Claude) (consequences)_

- The developer asked whether to use Peppol, which had come up in an earlier conversation.
- Background:
  - Peppol BIS Billing 3.0 is UBL 2.1 XML, with `Invoice` and `CreditNote` as separate root elements, and it is a CIUS of EN 16931.
  - Peppol is both a document format and a network (four-corner model, Access Points, AS4). We use only the format.
- Decided:
  - Use Peppol BIS Billing 3.0 (UBL 2.1 `Invoice`), with the official UBL 2.1 XSDs for structure.
  - Build a subset of the EN 16931 calculation rules (for example BR-CO-10 and BR-CO-15) in the domain, using the official rule IDs.
  - Full Schematron validation, which needs an XSLT 2 engine, becomes a follow-up.
  - Have one mapping from UBL to the domain model.
- Why: Peppol is the real-world standard and had already come up. The extra hour or so of work was accepted.

**2.6 Purchase vs sales derived from the token**. _Driven by: Both_

- Decided: purchase vs sales is derived from the token. The organisation's Peppol ID is compared with the `EndpointID` of the supplier and of the customer. If it matches neither, the document is rejected. The kind decides the counterparty for the VIES check.
- This reversed the earlier plan to treat UBL as a follow-up. It also dropped option 1, a separate field in the request.

**2.7 SaxonJS for the official rules (reopened by the developer)**. _Driven by: Developer (reopened), AI (Claude) (corrected itself)_

- The developer reopened the question: why not use SaxonJS to run the Schematron (as XSLT) instead of building the rules ourselves?
- Claude corrected itself: its claim that "an XSLT 2 engine is hard to run in Node" was too strong.
  - SaxonJS runs as a library inside Node, so no separate component is needed.
  - The stable versions are `saxon-js` 2.7.0 and `xslt3` 2.7.0 (October 2024), under the Saxonica licence: free of charge, but not open source.
  - `saxonjs-he` 3.0.0-beta2 is still in beta.
- Approach: at build time, compile the official EN 16931 and Peppol Schematron (as XSLT) to SEF with `xslt3`. Run the SEFs with SaxonJS, and convert the SVRL output to Problem Details that carry the rule IDs.
- Decided:
  - Run SaxonJS inside our own process.
  - First run a timeboxed spike (30–45 min, early, in parallel with the repo setup) to check that SaxonJS runs the official Peppol XSLTs. The fallback is the hand-built subset.
  - Run both XSD and Schematron synchronously at intake, because invalid documents must be rejected. _(Revised in 5.3.)_
- Consequences at the time:
  - A totals mismatch becomes an immediate rejection instead of an asynchronous `Failed`.
  - The VIES check stays asynchronous. "VAT number does not exist" is permanent and leads to `Failed`; "VIES unavailable" is transient and leads to a retry.
- Alternative considered: a Java validator (for example phive) in its own container. It is heavier on memory and conflicts with the assumption of a self-contained service.
- Note: before this, the developer had suggested running SaxonJS somewhere separate from the API. Claude replied that it could run in-process in the API. That was technically correct, but it missed the point of keeping heavy computation out of the API. The spike later proved the developer right (see 5.3).

**2.8 Credit notes**. _Driven by: Both_

- Decided: credit notes are weekend work.
  - Today, the design is made ready for them, with one strategy per document kind.
  - An incoming `CreditNote` is rejected with a clear "document type not (yet) supported" error.
  - In the follow-up conversation, show how little has to change to add them: a schema, a mapper and a strategy.
- Correction: Claude had said that a credit note has negative amounts. In UBL/Peppol a `CreditNote` normally has positive amounts, and the document type itself signals the credit.

**2.9 Request limits**. _Driven by: Both_

- Decided:
  - one document per request, no batches;
  - at most 1 MB per document. Embedded attachments are out of scope; they are a follow-up together with S3;
  - a rate limit per organisation instead of a hard daily quota.

**2.10 Idempotency in today's scope**. _Driven by: Developer (requirement), AI (Claude) (design)_

- Decided: idempotency through an `Idempotency-Key` header is part of today's scope.
- Why (developer): invoices must never be processed twice.
- Design:
  - The header is mandatory, and keys are scoped per organisation.
  - The same key with the same content (compared by hash) returns the original response with the same document ID.
  - The same key with different content returns 409.
  - Keys are kept indefinitely, given about 1,000 documents per day.
  - A unique index catches races.

**2.11 Content hash across keys**. _Driven by: Developer (idea)_

- Decided: store a SHA-256 hash of each file.
  - A byte-identical file from the same organisation is recognised even under a new key.
  - It is rejected with 409 and a reference to the existing document.
- Accepted risk: the same invoice with different formatting gets through.

**2.12 Clear error messages**. _Driven by: Developer (requirement), AI (Claude) (format)_

- The developer required clear error messages for 4xx responses such as 409.
- Decided: use RFC 9457 Problem Details, with:
  - a stable, machine-readable `code` for each error;
  - a human-readable `detail`;
  - extra fields where useful, for example `existingDocumentId`, or XSD errors with line and column;
  - no internal details ever, such as stack traces or SQL.

**2.13 XML in, JSON out**. _Driven by: Developer_

- Decided: requests carry XML, and responses (status, errors, results) are JSON.
- Why: this is a Node server, so JSON is the most natural choice.

**2.14 Business-level duplicate check deferred**. _Driven by: Developer_

- Claude proposed checking today that invoice numbers are unique per organisation. This was not adopted; it goes into the README as a step towards production.
- Why (developer):
  - In production, customers send fields in different ways ("ref", "invoice ref", "fac nummer"), so a field mapping has to come first.
  - The schema we validate against is our own assumption, not necessarily what production expects.
  - Building that mapping layer takes time and means making assumptions about a part of the system nobody asked for.
- Framing for the follow-up conversation:
  - Within our own schema this would be a single unique index; it was deferred to keep the scope down.
  - In production, with several formats (UBL/Peppol, SI-UBL in the Netherlands), an anti-corruption layer to a canonical domain model has to come first. Only after that does a business-level duplicate check make sense.
  - Credit notes and corrections also make the rule less simple.

## 3. Architecture

**3.1 Event sourcing (light)**. _Driven by: Both_

- Decided:
  - An event table in PostgreSQL with a unique `(stream_id, version)` for optimistic concurrency.
  - A status table (the read model), updated in the same transaction.
  - The event table also serves as the outbox, with a relay to RabbitMQ. _(Corrected in 3.2.)_
  - No snapshots, since a document has at most about 10 events.
  - This makes a history endpoint per document possible.
- Downsides to name openly:
  - more concepts (projections, rehydration);
  - ad-hoc queries go through the read model;
  - event versioning and upcasting in the long run.
- See [ADR 0003](adr/0003-event-sourcing-in-postgresql.md).

**3.2 Separate outbox table (correction)**. _Driven by: Both (a correction of the first proposal; the log does not say who raised it)_

- Decided: use a separate outbox table, written in the same transaction and pointing to the event, instead of using the event table as the outbox.
- Why:
  - Events are immutable.
  - Reading events by sequence number has a trap: a transaction that commits later but holds a lower number gets skipped.
- The relay uses `FOR UPDATE SKIP LOCKED` and marks a row only after the publisher confirm arrives.

**3.3 Only the relay talks to RabbitMQ**. _Driven by: Both_

- Decided: anything that wants to publish, including retries, writes to the outbox in the same transaction.

**3.4 Retries and poison messages**. _Driven by: Both_

- Decided:
  - Retries: one queue per delay (for example 5 s, 30 s and 2 min, configurable for the demo). Each has a TTL and dead-letters back to `documents.process`. After the maximum number of attempts, `DocumentProcessingFailed` moves the document to `Failed`.
  - Poison messages: quorum queues with a delivery limit and a DLQ.

**3.5 Idempotent consumer, no inbox table**. _Driven by: Both_

- Decided: the consumer is idempotent through the document status and the unique `(stream_id, version)`. There is no separate inbox table.
- Why: an inbox table only pays off for side effects that the aggregate does not guard, such as email or payments. VIES is only a lookup.
- The developer felt the naming should be "inbox", since we receive the document. The resulting framing is that both apply, at different boundaries:
  - For the document, we are the receiver: store it durably first, and only then return 202. That is the inbox idea.
  - For the events, we are the producer: that is the outbox.

**3.6 Storing and publishing must not fail**. _Driven by: Developer (requirement)_

- Requirement: once a document passes validation, the file must be stored and the event published, and this must not fail.
- Made precise:
  - Storing is atomic: one transaction.
  - Publishing is guaranteed, but may happen later. If RabbitMQ is down, the API still accepts the document, and the relay publishes once RabbitMQ is back.
  - If PostgreSQL is down, the API returns 503, and the client can safely retry with the same `Idempotency-Key`.
- See [ADR 0004](adr/0004-transactional-outbox-and-idempotent-consumer.md).

**3.7 No saga**. _Driven by: Both_

- Decided: no saga, with an ADR explaining why.
  - The process is linear, within one service, and there is nothing to compensate.
  - Coordination (counting attempts, deciding to retry or give up) lives in the `Document` aggregate as a state machine. "At most N attempts" is a domain rule.
- Pitfall: `@nestjs/cqrs` sagas run on the in-memory event bus, so a crash after the commit loses the command.
  - Rule: anything that must not be lost goes through the outbox and RabbitMQ, never through the in-memory event bus.
- Follow-up scenario: a saga or process manager once processing touches several systems with side effects (accounting, payments, webhooks).

**3.8 Code structure**. _Driven by: Both_

- One codebase and one Docker image, run as two processes with two start commands. The two processes scale independently.
  - The API process handles HTTP, authentication and validation. It talks only to PostgreSQL, never to RabbitMQ.
  - The worker process runs the consumer and the outbox relay. `SKIP LOCKED` makes it safe to run several relays.
- Hexagonal layout:
  - `apps/service/src/documents/{domain, application/{commands,queries,ports}, adapters/{inbound,outbound}}`;
  - `shared/` for the auth guard, Problem Details, config and logging;
  - `main-api.ts` and `main-worker.ts`;
  - `apps/web/` comes at the weekend.
- Commands: `SubmitDocument` (API) and `ProcessDocument` (worker).
- Queries: status, list, result and history. They read from the status table, never through the aggregate.
- Ports: `EventStore`, `ReadModel`, `BlobStore`, `Outbox`, `DocumentValidator`, `VatNumberVerifier`, `Clock`.
- From `@nestjs/cqrs` we use only `CommandBus` and `QueryBus`, not its `AggregateRoot` or `EventBus`. The domain stays framework-free, and the in-memory bus is not durable. We write our own small `AggregateRoot` base class.
- Dependency rules are enforced in CI. The tool was dependency-cruiser or eslint-plugin-boundaries; dependency-cruiser was chosen later (see 5.4).
  - The domain imports nothing.
  - The application layer imports only the domain.
  - Only adapters contain NestJS, database or RabbitMQ code.

**3.9 Work in parallel (14:05)**. _Driven by: Both_

- Decided: run as much as possible in parallel. The validation spike was started as a background agent. It covered XSD via xmllint-wasm, Schematron via SaxonJS, licences and timings.

**3.10 A dedicated event store was seriously considered**. _Driven by: Developer (requirement)_

- Requirement: the README and the ADR must make clear that a dedicated event store was considered seriously. The developer confirmed the analysis below.
- KurrentDB (formerly EventStoreDB), the case for it:
  - It is built for event sourcing: streams and optimistic concurrency.
  - It has native (persistent) subscriptions, so no polling relay is needed.
  - It has built-in projections and replays.
  - It could take over part of RabbitMQ's role.
  - Its Node client, `@kurrent/kurrentdb-client` 1.3.2, is Apache-2.0 licensed.
- What decided against it, for now: we would lose the single ACID transaction covering the event, read model, idempotency key and XML storage.
  - The dual write comes back.
  - Projections become eventually consistent.
  - Idempotency has to be done differently.
- Other points against it:
  - extra infrastructure to run (operations, backup, security, monitoring, memory);
  - overlap with RabbitMQ;
  - a volume of 1,000 documents per day does not call for it.
- A library was also considered: Emmett (`@event-driven-io/emmett-postgresql` 0.42.x, still 0.x, actively developed). Against our own implementation it means an extra dependency and a learning curve, while our own code stays small and fully explainable.
- When KurrentDB would be the right choice:
  - many consumers or projections that want to subscribe to the event stream directly;
  - several services using the event stream as their backbone;
  - replays at scale;
  - event volumes where a polling relay becomes the bottleneck.
- Migration path: give the `EventStore` port a different adapter. Honestly, that is not a pure swap, because the atomicity assumption (inline projection, idempotency in the same transaction) changes with it.

## 4. Security

**4.1 Authentication and authorisation**. _Driven by: Both_

- Mock IdP: its own small app, `apps/mock-idp`, of about 80 lines.
  - OAuth2 client credentials: `/token` takes a client_id and secret and returns a JWT valid for 15 minutes.
  - JWKS at `/.well-known/jwks.json`.
  - Moving to Cognito, Entra or Keycloak means changing a URL in the config.
- Keycloak in Compose was considered and rejected: it needs 0.5–1 GB of RAM, which did not fit the memory budget of the local container setup.
- API keys were considered and rejected: they live long, are hard to rotate, and have no standard way to express scopes.
- Token checks:
  - the signature, via JWKS;
  - `iss`, `aud` and `exp`;
  - an algorithm allowlist, so no `alg: none` and no algorithm confusion.
- Claims: `sub` (the client), `org_id`, `peppol_id`, `scope`.
- Scopes: `documents:submit` (submit) and `documents:read` (read).
- Ownership:
  - Always filter on `org_id` from the token, never from the URL or the body.
  - Another organisation's document returns 404, not 403.

**4.2 Secure by design, today**. _Driven by: Both_

- XML:
  - Reject any DOCTYPE (protects against XXE and billion laughs).
  - The parser and SaxonJS never fetch external files or URLs.
  - Enforce the 1 MB limit before parsing (413).
  - Accept only `application/xml` (415) and only UTF-8.
- HTTP:
  - Rate limit per organisation (429 with `Retry-After`).
  - helmet.
  - CORS closed; opened selectively for the frontend at the weekend.
  - Strict validation of URL parameters and headers (ID format, `Idempotency-Key`).
- Database:
  - The event table is append-only, enforced through privileges: the app role has INSERT and SELECT but no UPDATE or DELETE.
  - Separate app users, not the superuser.
  - RabbitMQ gets its own user; no `guest`.
- Secrets:
  - Secrets come from the environment, with a `.env.example`, and nothing secret goes in the repo.
  - Mock IdP keys are generated at startup.
- Logging:
  - Never log XML content, amounts or tokens; log only IDs.
  - The audit trail (who submitted what) lives in the event metadata.
- Container: multi-stage build, non-root user, no devDependencies.
- CI: `pnpm audit` and Dependabot, plus CodeQL because the repo is public.

**4.3 Secure by design, for production (in the README)**. _Driven by: Both_

- TLS at the ingress, plus HSTS.
- A shared rate limit (Redis); it is per instance for now.
- Encryption at rest (RDS, S3 KMS) and a secrets manager.
- The 7-year fiscal retention requirement and a deletion policy.
- Possibly mTLS for B2B clients.

## 5. Tooling

**5.1 Data access: Prisma**. _Driven by: Developer (choice); AI (Claude) recommended Kysely_

- Claude recommended Kysely, with Drizzle as an alternative. The developer chose Prisma as the easiest, fastest and most familiar option.
- At the weekend, a second adapter (for example Kysely) may follow as an experiment. It would show ports and adapters at work: swap the adapter, keep the same tests.
- Notes for the agents:
  - Version pitfall, checked on 12 November:
    - The npm `latest` dist-tag for `prisma` pointed at 8.0.0-rc.33, a release candidate, while `latest` for `@prisma/client` was 7.10.1.
    - So pin both exactly on 7.10.1 (stable, released 15 October 2026), and `@prisma/adapter-pg` on 7.10.1 too.
  - Raw SQL is needed in two places:
    - the outbox `FOR UPDATE SKIP LOCKED`, through `$queryRaw` or TypedSQL;
    - roles, privileges and append-only, as hand-written SQL in a migration created with `--create-only`.
  - One interactive transaction (`$transaction(async tx => …)`) covers the event, status table, outbox, idempotency key and XML. Adapters must pass the transaction client along (transaction context, or unit of work).
  - Map unique-index violations (`P2002`) to a concurrency conflict or an idempotency hit.
  - Prisma types stay in the outbound adapters and are mapped to domain objects; a lint rule guards this.

**5.2 Validation spike result (about 14:45)**. _Evidence: [spike 01](spikes/01-validation.md)_

- Both layers work.
  - The official CEN unit tests pass 1133/1133, and the Peppol unit tests 686/687.
  - The hand-built subset is not needed.
- XSD: use libxml2-wasm 0.7.2 (MIT), not xmllint-wasm.
  - It compiles the schema once (56 ms) and then takes 0.14–0.3 ms per invoice. xmllint-wasm takes about 69 ms per invoice.
  - Use the options `NONET|NO_XXE`, and never `NOENT`.
  - Reject any document with a DTD.
  - Check the root namespace and name, so `CreditNote` is rejected before the XSD step.
  - Always call `dispose()`.
- Schematron:
  - CEN 1.3.16 ships precompiled XSLT, which is compiled to SEF.
  - Peppol 3.0.22 ships only `.sch`, which is transpiled with SchXslt2 1.11.2 (MIT) and then compiled to SEF.
  - CEN 1.3.16 is the version that goes with Peppol 3.0.22, not 1.3.17.
  - Only `fatal` findings reject a document; warnings are shown.
- SaxonJS bug: `mod` on big integers is computed wrongly. It only affects DE-R-019/020 (a German IBAN check, flagged as a warning), so these are filtered out and documented.
- Performance:
  - A small invoice takes about 50 ms: CEN 40 ms plus Peppol 8.4 ms.
  - CEN grows linearly, at about 4.7 ms per line.
  - Peppol grows roughly quadratically:

    | Lines | CEN    | Peppol |
    | ----- | ------ | ------ |
    | 200   | 963 ms | 720 ms |
    | 400   | 1.9 s  | 2.6 s  |
    | 800   | 3.8 s  | 9.9 s  |

  - The `sync` transform blocks the event loop, so a `worker_threads` pool (piscina), a line-count cap and a timeout are needed.
  - Importing SaxonJS adds about 83 MB, and memory is about 210–240 MB RSS after warm runs.
- Build: do not commit the SEFs, because they are not reproducible. Generate them in a Docker build stage, which peaks at 600 MB–1 GB of RAM.
- Licences:
  - SaxonJS is free but proprietary, so it is used only as a dependency, never vendored, with a THIRD-PARTY-NOTICES entry.
  - The UBL 2.1 XSDs (OASIS) and the CEN artifacts (EUPL-1.2) may be committed unmodified.
  - The Peppol `.sch` has no licence, which is a grey area. So it is fetched at build time from a pinned URL with a sha256 check.
- Incident: the spike agent accidentally created three test files in the project folder and deleted them straight away. A check afterwards found the folder empty and `git status` clean.

**5.3 Split validation (revises 2.7)**. _Driven by: Both; the spike proved the developer's earlier instinct right_

- Decided: split validation into two stages.
  - Synchronous, in the API:
    - the size limit (1 MB) and the Content-Type check;
    - DOCTYPE rejection;
    - the root check (`Invoice` is accepted; `CreditNote` gets "not yet supported");
    - XSD validation with libxml2-wasm (under 1 ms).

    This covers the assignment's step of validating against a structure we define ourselves.

  - Asynchronous, in the worker:
    - The CEN EN 16931 and Peppol Schematron run via SaxonJS, in a `worker_threads` pool (piscina) with a timeout and no line-count cap.
    - A fatal violation is a permanent `Failed`, with the list of rule IDs and messages.
    - The VIES check follows, with its permanent and transient errors.
  - The API no longer needs SaxonJS, which makes it lighter.
  - Rejected invoices stay stored, together with the reason.
- Why: the spike showed that the Peppol rules scale roughly quadratically and that the transform blocks. Claude's earlier assumption about performance did not hold for large invoices.
- See [ADR 0002](adr/0002-split-validation-xsd-sync-schematron-async.md).

**5.4 Build, tests and quality**. _Driven by: Both_

- Backend build: `nest build` with SWC, not Vite. esbuild does not support `emitDecoratorMetadata`, which NestJS dependency injection needs.
- Tests:
  - Vitest with `unplugin-swc`, the official NestJS recipe.
  - Unit tests cover the pure domain plus the command and query handlers, using in-memory fakes of the ports instead of a mocking framework.
- E2E tests:
  - Vitest against the real stack (PostgreSQL, RabbitMQ, API, worker, mock IdP), locally and in CI.
  - They use the same `docker-compose.yml` as the demo.
  - Testcontainers was considered and rejected: it needs extra configuration of the local container runtime and a Ryuk container, for little gain.
- E2E scenarios:
  - happy path: submit → `Completed` → result;
  - XSD rejection;
  - Peppol rule violation → `Failed` with rule IDs;
  - VIES transient error → retry → `Completed`;
  - VIES invalid VAT number → `Failed`;
  - idempotency: the same key gives the same ID; the same key with different content gives 409; the same file with a new key gives 409;
  - auth: 401, 403, and 404 for another organisation's document;
  - credit note rejected.
- Frontend (weekend): Vite.
- Quality: TypeScript strict, ESLint and Prettier, and dependency-cruiser for the layer rules, all run in CI.

**5.5 RabbitMQ client library**. _Driven by: Developer (parallel spikes, preference), Both_

- `@nestjs/microservices` (the RMQ transport) was rejected. It uses its own message envelope and gives little control over confirms, quorum queues and DLX.
- The developer wanted the two remaining options tried in parallel by agents, with the results recorded to show later. The developer preferred an adapter of our own (amqplib + amqp-connection-manager), but doubted it would be more reliable than the library.
- Around 15:00, two spikes started with the same spec and the same tests, T1 to T6, each with its own RabbitMQ container:
  - Tests:
    - T1: confirms;
    - T2: retry via TTL;
    - T3: poison message → DLQ;
    - T4: broker restart while publishing;
    - T5: broker restart while consuming;
    - T6: crash between commit and ack.
  - Spikes:
    - A: `@golevelup/nestjs-rabbitmq` 9.1.2, see [spike 02a](spikes/02a-rabbitmq-golevelup.md);
    - B: `amqplib` 2.3.1 with `amqp-connection-manager` 5.0.1, see [spike 02b](spikes/02b-rabbitmq-amqplib.md).
- Background: golevelup 9.1.2 is itself built on amqplib ^0.10.9 and amqp-connection-manager ^5, so the building blocks are the same. The difference is who decides the ack, nack and confirm behaviour: the library's defaults, or our own code. NestJS `latest` is 12.5.0.

**5.6 Spike A result (about 15:40)**

- T1 to T6 pass, with 0 confirmed messages lost, including during an 11 s outage. The adapter is 181 lines in 4 files.
- Findings that apply to both approaches:
  - The broker is RabbitMQ 4.4.0. On quorum queues, `nack(requeue)` does not count toward `x-delivery-limit`: a poison message was redelivered about 24k times in 30 s. `reject(requeue=true)` and closing the channel do count, so use `reject`. This finding was passed on to spike B.
  - Broker restarts and crashes during processing raise `x-delivery-count`, so the delivery limit must not be too low (for example 10). It is only protection against poison messages; our own retry count lives in the outbox and the aggregate.
  - A confirm does not mean the message was routed: a message with no matching binding is confirmed and then dropped. Use `mandatory: true` and treat `basic.return` as an error, or use an alternate exchange.
  - Without a timeout, a publish hangs forever during an outage, so a timeout is mandatory.
  - Duplicate deliveries can arrive at the same time (an ack on a dead channel after a reconnect). Idempotency must handle concurrent duplicates, which the unique `(stream_id, version)` does.
  - During a long outage, about 10–14 publishes are rejected even though the broker did receive them. The relay then publishes them again, which creates duplicates, so the consumer must be idempotent.
  - Toolchain:
    - NestJS 12 is ESM-only. A CommonJS build with TypeScript 5.9 works through Node 22's `require(esm)`.
    - `typescript@latest` is 7.0.2, so we pin 5.9.3; TypeScript 7 was not tested.
- Specific to golevelup:
  - Confirms are on by default, via amqp-connection-manager.
  - A per-message timeout is only possible through an untyped option, which needs a cast.
  - It acks right after the handler resolves, which amounts to ack after commit.
  - The topology is declared in config, which is easy to explain.
  - Confirms and reconnects live two packages deep. The question "where is the confirm?" cannot be answered by pointing at our own code.
  - Because of static state, only one Nest app can run per process.

**5.7 Spike B result (about 16:00)**

- T1 to T6 pass, with 0 confirmed messages lost, including with SIGKILL on the broker. The adapter is 273 lines in 5 files (about 202 without blank lines and comments).
- Delivery limit:
  - Spike B confirms that nack does not count and reject does: with nack, a poison message was redelivered 23,771 times.
  - A broker restart and a consumer SIGKILL both raise `x-delivery-count`, so consider a limit of 5–10.
  - Messages in the DLQ must be replayable.
- `mandatory: true` with `basic.return` makes an unroutable message come back as rejected instead of confirmed (verified).
- At-least-once dead-lettering works only with `x-overflow: reject-publish`. Without it, messages are lost silently; the only sign is a warning in the broker log.
- Publisher design:
  - It does not use amqp-connection-manager's in-memory buffer, because the outbox is already the durable buffer. It fails fast instead.
  - It resolves only inside the confirm callback, with a 5 s timeout.
  - "Rejected means unknown, not 'not delivered'": in two tests, 1 of 105 and 20 of 20 rejected messages arrived anyway. So the relay publishes again, and the consumer is idempotent.
- Pitfalls:
  - `ChannelWrapper.ack()` acks on the current channel, which is wrong after a reconnect. So ack on the channel the delivery came from.
  - A channel error without a lost connection is not recovered. For example, changed queue arguments cause a 406, and startup hangs.
  - A consumer cancel is only logged.
  - Proposed fix: on an unexpected channel close or cancel, stop the process (fail fast) and let the restart policy start the worker again.
- Restart tests: `docker restart` is too gentle. `docker pause` or `kill -s KILL` is needed to catch messages that were sent but not yet confirmed.
- Possible alternatives, not evaluated, kept as follow-ups:
  - amqplib 2.x's own connection recovery instead of amqp-connection-manager;
  - `delayed_retry` on quorum queues in RabbitMQ 4.4, as a native alternative to TTL retry queues.

**5.8 Decision: own adapter**. _Driven by: Developer (preference, confirmed by the spikes), Both_

- Comparison: both spikes passed every test.
  - A is shorter and declares its topology in config. But confirms, reconnects and ack behaviour are hidden inside the library, and its timeout option is untyped.
  - B is a little more code. Every guarantee is visible in our own code, and it fits the outbox (fail fast).
- Decided: B, our own adapter on amqplib 2.3.1 and amqp-connection-manager 5.0.1. The spike B code is the starting point for work package G04. Also decided:
  - fail fast on an unexpected channel close or consumer cancel: the process stops and the restart policy restarts it;
  - a delivery limit of 5–10;
  - at-least-once dead-lettering with reject-publish;
  - `mandatory` publishing, with returned messages handled;
  - `reject` instead of `nack`.
- The validation spike report is kept as [docs/spikes/01-validation.md](spikes/01-validation.md).
- See [ADR 0006](adr/0006-own-rabbitmq-adapter.md).

**5.9 Package manager**. _Driven by: Both_

- Decided: pnpm with workspaces (`apps/service`, `apps/mock-idp`, later `apps/web`), with the version pinned through `packageManager` in `package.json`.
- Supply chain:
  - Install scripts are blocked by default, with an explicit allowlist (Prisma, SWC, …).
  - `minimumReleaseAge` is 3 days (4,320 minutes).
- Version:
  - pnpm 12.16.1 was proposed first, but Corepack cannot start pnpm 12. It looks for `bin/pnpm.cjs`, and pnpm 12 ships `pnpm.mjs` or a native binary.
  - So we use pnpm 10.34.9, released 25 October 2026. The 10 line is still maintained, and this version was tested to work through Corepack.
  - Agents also know pnpm 10 configuration best, which means fewer surprises today.

**5.10 Prisma versions pinned**. _Driven by: Both_

- Decided: `prisma`, `@prisma/client` and `@prisma/adapter-pg` are pinned exactly on 7.10.1.
- Why: the npm peer range is `*`, but the CLI generates code for the runtime of its own version, and Prisma warns when the versions differ.

## 6. Publication

**6.1 Public repository**. _Driven by: Both_

- Decided:
  - The repository is public, under the developer's own GitHub account.
  - No company name appears in the repo.
  - The assignment text is not copied; the README describes the problem in our own words.
  - The repo may be made private once the process is over.

**6.2 Repository name**. _Driven by: Developer_

- Decided: `xml-invoice-processor`.
- Why: Peppol is one of several standards and more may follow, which fits the anti-corruption-layer follow-up scenario.

**6.3 Artifacts**. _Driven by: Both_

- `ci.yml`, on push and PR:
  - frozen install, lint, typecheck, layer rules, unit tests, build and `pnpm audit`;
  - a separate e2e job that runs the full stack via Compose.
- `release.yml`, on push to main and on tags:
  - images to GHCR: `ghcr.io/<owner>/xml-invoice-processor` (API and worker) and `…-mock-idp`;
  - multi-arch builds (amd64 and arm64) on native runners, which are free for public repos;
  - an SBOM and build attestation if time allows.
- One `docker-compose.yml`:
  - `docker compose up` uses the GHCR images, and `--build` builds them locally;
  - a dev profile runs only PostgreSQL and RabbitMQ.
- A demo script, `pnpm demo`, gets a token from the mock IdP and runs scenarios with sample invoices: happy path, XSD rejection, Peppol rule violation, VIES retry and idempotency.
- A live demo is optional (weekend; Fly or Render plus CloudAMQP). The fallback is a recording of the demo script.
- After the first release, the GHCR package may be made public by hand.

**6.4 Semantic versioning**. _Driven by: Developer (requirement); the details were confirmed by the developer_

- Decided:
  - Tags follow `vMAJOR.MINOR.PATCH`, starting with `v1.0.0` today.
  - Images are tagged `1.0.0`, `1.0`, `1` and `latest`, plus `sha-…` and `main`.
  - Weekend work becomes `v1.1.0` (new features) or `v1.0.x` (fixes).
  - Conventional Commits and a `CHANGELOG.md`; release-please is a follow-up.

## 7. Way of working

**7.1 How `/goal` works**. _Background, looked up by a Claude Code documentation subagent_

- Claude Code has a `/goal <condition>` command:
  - One goal per session.
  - After each turn, a small model decides from the transcript alone whether the goal is not yet met, met, or impossible. It runs no commands and reads no files.
  - There is no built-in turn limit, so you add "or stop after N turns" yourself.
  - The condition can be at most 4,000 characters.
  - Headless use: `claude -p "/goal …"`.
  - It does not change the permission mode, so unattended work needs auto mode.
  - How it behaves in worktrees is not documented.
- Consequence (proposal):
  - Each goal condition is written to stand on its own. It lists verification commands whose output and exit code must appear in the transcript, plus a scope check (`git diff --stat`) and a turn limit.
  - Because a model gives the verdict, CI on the PR and our own review are the hard check. This is the verify-and-inspect step of the plan.

**7.2 Goal setup**. _Driven by: Both (the developer confirmed that "goals" means Claude Code's `/goal`)_

- A root `CLAUDE.md` with:
  - context, and links to the ADRs;
  - architecture rules: the layers, only the relay publishes, never the in-memory event bus for critical paths, no Prisma types in the domain;
  - conventions: English, Conventional Commits, TypeScript strict, exact versions, no release candidates, `minimumReleaseAge`;
  - commands;
  - a Definition of Done for each goal: lint, typecheck, layer rules and tests green, and the ADRs and AI log updated when choices are made;
  - the pitfalls found in the spikes.
- A `docs/goals/NN-name.md` file per goal, with:
  - the goal in one sentence;
  - context links;
  - what is in and out of scope;
  - acceptance criteria written as commands;
  - dependencies;
  - ownership, as a list of folders;
  - a ready-to-use `/goal` condition. It stands on its own, requires the verification output and exit codes in the transcript, includes a `git diff --stat main` scope check, and ends with "or stop after N turns".
- A goal is only done when CI on its PR is green and we have reviewed it.

**7.3 Parallel way of working**. _Driven by: Both_

- Phase 1, the foundation, is done in sequence by the coordinating session:
  - the repo and workspace;
  - the NestJS skeleton (API and worker);
  - Compose, the Prisma basics and the CI skeleton;
  - `CLAUDE.md` and the goal files;
  - above all the contracts (ports, interfaces and domain event types), so that the tracks can run in parallel.
- Phase 2 runs tracks in parallel:
  - Each track has its own worktree and branch, `goal/NN-name`.
  - The developer starts a Claude Code session per worktree, in auto mode, with the `/goal` condition.
  - At most 3 run at once, because of the development machine's memory.
  - Locally, the tracks run only unit and adapter tests. E2E runs in CI and in the integration phase.
- Phase 3, integration, is done in sequence: wire everything together and get all e2e scenarios green.
- "Done" means a PR to main, green CI, a review, and a squash merge with a Conventional Commit title.
- Four layers of control:
  1. the agent, through `/goal`;
  2. CI on the PR;
  3. the coordinating session, which reviews against this log and the architecture rules and writes the docs in the meantime;
  4. a last look by the developer before merging.

**7.4 Goal breakdown**. _Driven by: Both. The developer answered "Yes", and Claude took that as agreement on both open questions._

- Phase 1, the foundation, done by the coordinating session:
  - the repo and workspace;
  - TypeScript 5.9.3, lint, dependency-cruiser and Vitest;
  - the NestJS skeleton, with the ESM/CJS choice made after a test;
  - Compose and the CI skeleton;
  - the contracts: event types, ports, and the Prisma schema with its first migration;
  - `CLAUDE.md`, the goal files and `docs/spikes/`.
- Wave 1:
  - G01 Domain core;
  - G03 Persistence (Prisma);
  - G04 Messaging (our own RabbitMQ adapter and the relay).
- Wave 2:
  - G02 Validation: XSD, Schematron with piscina, the artifacts, the UBL mapper and the VIES fake;
  - G05 HTTP and security: endpoints, auth, Problem Details, limits, OpenAPI and the mock IdP;
  - G06 Delivery: Dockerfile, Compose, `release.yml`, the e2e CI job and Dependabot.
- Phase 3: G07 Integration (wiring, the worker pipeline, retries via the outbox, all e2e tests green, the demo script and sample invoices), then a review, then `v1.0.0`.
- Throughout, the coordinating session writes the README, the ADRs and the AI log, and reviews PRs.

**7.5 Reducing integration risk**. _Driven by: Developer (concern), Both (solution)_

- The developer worried whether wiring everything together would go smoothly.
- Decided: reduce the integration risk up front, in phase 1, with two measures:
  - Contract tests per port: the same test suite runs against the fake and against the real adapter.
  - A walking skeleton: the composition roots of the API and the worker are wired with in-memory fakes from the start, so the app runs end to end. The tracks replace fakes with real adapters, and G07 is then mostly a matter of switching bindings and running the e2e tests.
- This adds about 30 minutes to phase 1.

**7.6 Documentation**. _Driven by: Both_

- All documentation is in English:
  - ADRs in `docs/adr/NNNN-title.md`, about 12 of them. Each is at most one page, with Status, Context, Decision, Alternatives considered, Consequences, Evidence and Follow-ups.
  - `docs/ai-usage.md`, structured along the questions the assignment asks: which tools, for what, what was changed, what was deliberately not adopted and why, how the output was checked, and the time spent by people and by agents.
  - A short README: what the service is, a quick start (`docker compose up`, `pnpm demo`), a Mermaid architecture diagram, the choices with links to the ADRs, the assumptions, next steps towards production, and a short AI summary with a link.
  - `docs/decision-log.md`: this document.
  - `docs/spikes/`: the three spike reports.

**7.7 Crash-scenario tests**. _Driven by: Both_

- Deterministic tests with fault injection, always run in CI (G01/G04):
  - the relay crashes after publishing but before marking the row: the message is published again but not processed twice;
  - the worker crashes after the commit but before the ack;
  - the same message is delivered twice at the same time.
- Contract tests against a real database, always run in CI (G03):
  - concurrent requests with the same `Idempotency-Key` result in one document;
  - two workers on the same document produce exactly one winner.
- E2E tests on real infrastructure, in CI (G07):
  - RabbitMQ down during submission: the API returns 202, and the document reaches `Completed` once RabbitMQ recovers;
  - PostgreSQL down: the API returns 503, and a retry with the same key results in one document.
- Optional, at the weekend: the spike chaos tests as `pnpm test:chaos` (pausing and killing the broker).
- Framing for the follow-up conversation: in practice, the contract tests against real adapters became the integration layer. That is a deliberate adjustment of the usual test pyramid.

**7.8 Walkthrough finished (about 15:50)**

- Phase 1 (the foundation) starts.

**7.9 Language**. _Driven by: Developer_

- Decided: everything is in English: README, ADRs, AI log, docs, spike reports, code, commits, and API and error messages. The Dutch log was translated into this document.
- Claude had proposed Dutch docs with English code; the developer chose English throughout.

## Summary: AI suggestions that were adapted or not adopted

- **Language.** Claude proposed Dutch documentation with English code. The developer chose English for everything (7.9).
- **Where Schematron runs.** Before the session, the developer suggested running SaxonJS somewhere separate from the API. Claude answered that it could run in-process in the API. That was technically correct, but it missed the point of keeping heavy computation out of the API. The spike proved the developer right: the heavy work now runs in the worker (5.3).
- **Performance assumption.** Claude assumed that running Schematron synchronously would cost no noticeable performance. The spike showed this was wrong for large invoices, where the cost grows quadratically and blocks. The decision was revised to split validation: XSD synchronously, the rules asynchronously (5.3).
- **Data access.** Claude recommended Kysely, with Drizzle as an alternative. The developer chose Prisma for familiarity and speed. Another ORM may follow as a weekend experiment (5.1).
- **Business-level duplicate check.** Claude proposed adding an invoice-number check today. It was not adopted and is deferred to production, because customers' fields first need mapping (2.14).
- **Content hash across keys.** This was the developer's idea, added on top of Claude's `Idempotency-Key` proposal (2.11).
- **Problem Details.** Claude proposed the format; the requirement for clear error messages came from the developer (2.12).
- **Invoice format.** Claude proposed a simplified invoice XSD of our own. The developer steered towards Peppol BIS 3.0, which had come up in an earlier conversation. Claude then worked out the consequences: the UBL XSDs, a subset of the calculation rules, Schematron as a follow-up, and purchase vs sales from the token (2.5, 2.6).
- **Purchase vs sales.** This was the developer's requirement. Claude pointed out that it is a matter of perspective, not a property of the document (2.4).
- **XSLT 2 in Node.** Claude's claim that "an XSLT 2 engine is hard to run in Node" was too strong. The developer pressed on SaxonJS, which runs in Node without trouble. This led to the official Schematron rules instead of a hand-built subset (2.7).
- **Credit note amounts.** Claude had said a credit note has negative amounts. In UBL/Peppol a `CreditNote` normally has positive amounts, and the document type signals the credit (2.8).
