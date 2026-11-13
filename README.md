# xml-invoice-processor

A backend that receives **Peppol BIS Billing 3.0 invoices (UBL 2.1 XML)** from B2B systems over
HTTPS, validates them, stores them so that an accepted document is never lost, and processes them
asynchronously. Every document has a status: `Received`, `Processing`, `Completed` or `Failed`.

- [Quick start](#quick-start)
- [Check that it really ran](#check-that-it-really-ran)
- [API](#api)
- [Architecture](#architecture)
- [Reliability: what happens when something fails](#reliability-what-happens-when-something-fails)
- [Key decisions and trade-offs](#key-decisions-and-trade-offs)
- [Assumptions](#assumptions)
- [Security](#security)
- [Testing, CI/CD and monitoring](#testing-cicd-and-monitoring)
- [Next steps](#next-steps)
- [AI usage](#ai-usage)

## Quick start

Requirements: Docker with Compose v2 (2 GB of memory for the VM is enough; building the images
yourself needs buildx 0.17 or newer), Node 22 and pnpm 10 (through Corepack) for the demo script.

```bash
git clone https://github.com/gimme4bucks/xml-invoice-processor.git && cd xml-invoice-processor
corepack enable && pnpm install
docker compose --profile full up -d --build --wait   # Postgres, RabbitMQ, migrations, API, worker, mock IdP, HTTPS edge
pnpm demo                                            # walks through every scenario against the running stack
pnpm e2e                                             # the end-to-end tests, including RabbitMQ and Postgres outages
docker compose --profile full down --volumes         # stop everything and remove the data (and the edge's CA)
```

The first build takes a few minutes: it downloads the Peppol rules (sha256-checked) and compiles
them. To skip it, use the published release images instead: they are public on GHCR
(`ghcr.io/gimme4bucks/xml-invoice-processor` and `-mock-idp`, linux/amd64 and linux/arm64).

```bash
docker compose --profile full pull           # the latest release; prefix both commands with TAG=1.0.0 to pin it
docker compose --profile full up -d --wait   # no --build: uses the pulled images
```

`pnpm demo` prints each step; it ends with `All scenarios behaved as expected.` The
[examples](examples/README.md) show the same flows with curl, the demo clients and what each
example invoice does.

The API and the mock IdP are only reachable over HTTPS, through a Caddy reverse proxy (the
`edge`) with its own local CA ([ADR 0013](docs/adr/0013-tls-at-the-edge.md)). `pnpm demo` and
`pnpm e2e` export its root certificate and trust it by themselves; nothing switches certificate
verification off. For curl, `pnpm tls:ca` exports it to `.tls/edge-root-ca.crt`:

```bash
curl --cacert "$(pnpm -s tls:ca)" https://localhost:3443/health   # {"status":"ok"}
```

| What                   | Where                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------- |
| API                    | https://localhost:3443                                                                 |
| OpenAPI (Swagger UI)   | https://localhost:3443/docs, JSON at `/openapi.json` (the browser warns, see below)    |
| Mock identity provider | https://localhost:4443 (`POST /token`, `/.well-known/jwks.json`)                       |
| Edge root certificate  | `pnpm tls:ca` (a new one after `down --volumes`)                                       |
| RabbitMQ management    | http://127.0.0.1:15672 (user `xip`, password `xip`; a local tool, not behind the edge) |

The demo clients and their secrets in `docker-compose.yml` are for local use only. A browser
does not know the edge's CA, so Swagger UI shows a certificate warning unless you add
`.tls/edge-root-ca.crt` to your system or browser as a trusted root.

**Local development** (Node processes against Dockerised Postgres and RabbitMQ):

```bash
corepack enable && pnpm install
cp .env.example .env && cp .env.example apps/service/.env
pnpm infra:up                                  # Postgres 18 + RabbitMQ 4.4
pnpm -F @xip/service prisma:generate && pnpm -F @xip/service prisma:migrate
pnpm -F @xip/service build:validation          # fetches and compiles the Schematron rules
pnpm verify                                    # format, lint, types, architecture rules, unit tests, build
pnpm test:contract                             # the port contracts against real Postgres and RabbitMQ
```

During local development the API (port 3000) and the mock IdP (port 4000) run natively and speak
plain HTTP on `localhost`; only the full compose stack has the HTTPS edge.

## Check that it really ran

`pnpm demo` checks every response itself and exits with a non-zero code when one is wrong. These
are five ways to see for yourself that the documents really went through Postgres, RabbitMQ and
the worker, against the running stack from the quick start.

**1. Stop the worker.** Processing depends on the worker, and nothing is lost while it is down:

```bash
docker compose stop worker
pnpm demo                    # stops at "Received (attempts: 0)" for the first invoice
docker compose start worker  # in a second terminal, within 90 seconds
```

While the worker is down, the document waits in the outbox table, because the outbox relay runs in
the worker. RabbitMQ stays empty in the meantime:

```bash
docker compose exec postgres psql -U xip -d xip -c "select routing_key, created_at from outbox where published_at is null"
```

Once the worker is up, the demo continues and ends as usual. In the history it prints, the gap
between `DocumentReceived` and the first `ProcessingStarted` is the time the worker was down. If
you wait longer than 90 seconds, the demo gives up with `… is still Received`, but the document is
still processed as soon as the worker starts.

**2. The event history in Postgres.** Every document has its own event stream. Its document ID is
the one the demo prints:

```bash
docker compose exec postgres psql -U xip -d xip -c "
  select d.document_id, d.status, d.attempts,
         string_agg(e.type, ' > ' order by e.version) as history
  from document_views d join events e on e.stream_id = d.document_id
  group by d.document_id, d.status, d.attempts, d.received_at
  order by d.received_at"
```

The API returns the same history at `GET /documents/{id}/history`, which you can also call from the
Swagger UI with a token from the mock IdP (see the [examples](examples/README.md)).

**3. RabbitMQ management** (http://127.0.0.1:15672, user `xip`, password `xip`):

- Under _Queues_, `documents.process` carries every document, and its message rates rise while the demo runs.
- The `documents.retry.*` queues receive the VIES retries.
- `documents.dlq` stays empty.

The retry queues are named after the production delays (5 s, 30 s and 2 min). Compose shortens them
to 1, 2 and 5 seconds (`RETRY_DELAYS_MS`, shown as `x-message-ttl` on each queue) to keep the demo
quick.

**4. The API logs.** This shows every request from the demo as a JSON line with its correlation id:

```bash
docker compose logs -f api | grep -v /health
```

The worker logs only at startup and on errors, not for every message. Its work shows in the event
history and in RabbitMQ instead.

**5. HTTPS at the edge.** The certificate is verified against the edge's own CA, verification
fails without it, and plain HTTP is refused instead of redirected:

```bash
curl -sv --cacert "$(pnpm -s tls:ca)" https://localhost:3443/health 2>&1 | grep -E 'issuer|SSL certificate verify|strict'
curl -sS https://localhost:3443/health       # without the CA: "SSL certificate problem: unable to get local issuer certificate"
curl -si http://localhost:3443/health        # plain HTTP: 400 "Client sent an HTTP request to an HTTPS server", no Location
docker compose ps api mock-idp               # no host ports: only the edge publishes 3443 and 4443
```

## API

All endpoints need an OAuth2 bearer token (client credentials). The organisation always comes from
the token, never from the URL or the body.

| Method and path               | Scope              | Purpose                                                                                                                  |
| ----------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `POST /documents`             | `documents:submit` | Submit one invoice (`application/xml`, UTF-8, at most 1 MiB, `Idempotency-Key` required). Answers `202` with `Location`. |
| `GET /documents`              | `documents:read`   | Your organisation's documents, newest first (`status`, `limit`, `cursor`).                                               |
| `GET /documents/{id}`         | `documents:read`   | Status, direction (purchase or sales), attempts and failure reason.                                                      |
| `GET /documents/{id}/result`  | `documents:read`   | The processing result (canonical JSON invoice) once `Completed`.                                                         |
| `GET /documents/{id}/history` | `documents:read`   | The document's event stream: the audit trail.                                                                            |

Errors are [RFC 9457 Problem Details](https://www.rfc-editor.org/rfc/rfc9457) with a stable
`code` that clients can branch on, plus a `correlationId`. The full catalogue is in the OpenAPI
description and in [ADR 0012](docs/adr/0012-problem-details-and-json-responses.md).

```http
HTTP/1.1 409 Conflict
Content-Type: application/problem+json

{ "type": "urn:xip:problem:DUPLICATE_DOCUMENT", "title": "Duplicate document", "status": 409,
  "code": "DUPLICATE_DOCUMENT", "detail": "…", "existingDocumentId": "…", "correlationId": "…" }
```

## Architecture

Two processes from one image: the **API** (intake and queries) and the **worker** (outbox relay
and message consumer). Both are NestJS applications built as ports and adapters around a pure
TypeScript domain.

```mermaid
flowchart LR
  client[B2B client] -- "POST /documents<br/>Bearer token + Idempotency-Key" --> api
  idp[Identity provider<br/>mock in dev] -. JWKS .-> api

  subgraph api [API process]
    direction TB
    guard[JWT guard, rate limit] --> xsd[Structure check<br/>DOCTYPE ban + UBL 2.1 XSD]
    xsd --> submit[SubmitDocument]
  end

  subgraph pg [PostgreSQL]
    direction TB
    events[(events<br/>append-only)]
    views[(document_views)]
    blobs[(blobs)]
    outbox[(outbox)]
    idem[(idempotency_records)]
  end

  submit -- "one transaction" --> pg
  api -- "GET status / result / history" --> views

  subgraph worker [Worker process]
    direction TB
    relay[Outbox relay]
    consumer[ProcessDocument] --> rules[EN 16931 + Peppol Schematron<br/>SaxonJS in worker threads]
    rules --> vies[VAT number check<br/>fake VIES]
  end

  outbox --> relay
  relay -- "publish with confirms" --> mq[[RabbitMQ<br/>quorum queues, retry delay queues, DLQ]]
  mq --> consumer
  consumer -- "events + view + result + retry outbox row,<br/>one transaction" --> pg
```

**The life of a document:**

1. **Intake (synchronous, API).** The token is verified and the body read (only after
   authentication). The structure is checked: no DOCTYPE, the root must be a UBL 2.1 `Invoice`,
   and the UBL 2.1 XSD must pass. The direction (purchase or sales) is derived from the token's
   Peppol ID and the invoice's supplier and customer EndpointIDs.
2. **Store (one transaction).** The idempotency record, the `DocumentReceived` event, the original
   XML, the read model row and an outbox message are written together. Only after the commit does
   the client get `202 Accepted`.
3. **Publish (worker).** The outbox relay publishes pending rows to RabbitMQ with publisher
   confirms and marks them published only after the confirm.
4. **Process (worker).** The consumer records `ProcessingStarted`, runs the official EN 16931 and
   Peppol BIS 3.0 business rules, verifies the counterparty's VAT number, stores the canonical
   JSON result and records `DocumentProcessed`, or `DocumentProcessingFailed` with the rule IDs.
   The message is acknowledged only after that transaction has committed.

```mermaid
stateDiagram-v2
  [*] --> Received: POST accepted (202)
  Received --> Processing: ProcessingStarted (attempt 1)
  Processing --> Completed: rules pass, VAT number valid
  Processing --> Failed: fatal rule violation, invalid VAT number, timeout
  Processing --> Processing: VAT service unavailable, retry after 5 s / 30 s / 2 min
  Processing --> Failed: still unavailable after 4 attempts
  Completed --> [*]
  Failed --> [*]
```

**Code layout** (enforced by dependency-cruiser in CI):

```
apps/service/src/
  documents/domain/            pure TypeScript: Document aggregate, events, value objects
  documents/application/       commands, queries, ports, outbox relay
  documents/adapters/inbound/  HTTP controller, RabbitMQ consumer, relay loop
  documents/adapters/outbound/ postgres (Prisma), rabbitmq (amqplib), validation, vies, in-memory
  app/                         composition root: the only place where ports are bound to adapters
  shared/                      config, auth, Problem Details, logging, rate limiting
apps/mock-idp/                 OAuth2 client-credentials issuer for development, demo and e2e
```

## Reliability: what happens when something fails

The guarantee: **an accepted document (202) is stored durably and will be processed; the same
invoice is never processed twice.** Delivery between the components is at-least-once, so every
consumer is idempotent.

| Failure                                             | What happens                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client retries after a timeout                      | Same `Idempotency-Key` and same body: the original `202` again, with `Idempotent-Replayed: true`. Never a second document.                                                                                                                                                                                                                                                                                |
| Same file sent again under a new key                | `409 DUPLICATE_DOCUMENT` (SHA-256 of the bytes, per organisation).                                                                                                                                                                                                                                                                                                                                        |
| RabbitMQ down during intake                         | No effect on the client: the API never talks to RabbitMQ. The outbox row waits and the relay publishes it when the broker is back.                                                                                                                                                                                                                                                                        |
| PostgreSQL down                                     | The API answers `503` within seconds, with `Retry-After`. The outcome is unknown (a write may still commit), so the client retries with the same key, which is always safe. The worker requeues with backoff (1 s doubling to 30 s).                                                                                                                                                                      |
| PostgreSQL down for more than about 2.5 minutes     | The worker's messages use up their 10 deliveries and are dead-lettered; their documents stay `Received` or `Processing`, but nothing is lost. `xip redrive` sends them back through the outbox (acking each DLQ message only after its requeue committed), and the sweeper does so by itself once a document has been unchanged for 15 minutes ([ADR 0014](docs/adr/0014-recovering-stuck-documents.md)). |
| A document stuck for any other reason               | The sweeper in every worker requeues documents that are not final, unchanged for 15 minutes and have no message waiting in the outbox, and logs a warning per document. Optimistic concurrency lets one worker win; the history records `ProcessingRequeued`.                                                                                                                                             |
| Relay crashes after publishing, before marking      | The message is published again. The consumer sees the document's state and skips the duplicate.                                                                                                                                                                                                                                                                                                           |
| Worker crashes mid-processing                       | The message was not acknowledged, so RabbitMQ redelivers it; the attempt resumes without a new event.                                                                                                                                                                                                                                                                                                     |
| Two deliveries of the same message at the same time | Optimistic concurrency on `(stream_id, version)`: exactly one wins, the other is skipped.                                                                                                                                                                                                                                                                                                                 |
| VAT service unavailable                             | `ProcessingAttemptFailed`, then a retry through the outbox and the delay queues (5 s, 30 s, 2 min). After 4 attempts: `Failed`.                                                                                                                                                                                                                                                                           |
| A message that keeps failing (poison)               | `reject` with requeue counts towards the quorum queue's delivery limit (10); then it is dead-lettered at-least-once to the DLQ.                                                                                                                                                                                                                                                                           |
| Business rules take too long                        | Timeout (30 s) in the worker thread: `Failed` with rule id `XIP-SCHEMATRON-TIMEOUT`, since the same document would time out again.                                                                                                                                                                                                                                                                        |

Events are append-only: a database trigger refuses `UPDATE`, `DELETE` and `TRUNCATE` on the
events table. A migration also provides a least-privilege role (`xip_app`) with only `SELECT` and
`INSERT` on it; the contract tests run as that role.

## Key decisions and trade-offs

Each decision has an ADR with the alternatives that were considered. The full reasoning, in the
order it was made, is in the [decision log](docs/decision-log.md).

| Decision                                                                                                                      | Why, and what it costs                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Peppol BIS 3.0 with the official rules (SaxonJS)](docs/adr/0001-peppol-bis-billing-3-official-rules-saxonjs.md)              | A real standard with real rule IDs instead of a home-made schema. Costs a build step and an XSLT 3 engine; SaxonJS is free but not open source.                                                                                                                          |
| [Split validation](docs/adr/0002-split-validation-xsd-sync-schematron-async.md)                                               | XSD at intake (fast, immediate 422), business rules in the worker: the Peppol rules take up to ~10 s on an 800-line invoice and block the event loop. A client learns about a rule violation by polling.                                                                 |
| [Event sourcing in PostgreSQL](docs/adr/0003-event-sourcing-in-postgresql.md)                                                 | A full audit trail and natural idempotency, without a second database to run. A dedicated event store (KurrentDB) was analysed and deferred.                                                                                                                             |
| [Transactional outbox, idempotent consumer](docs/adr/0004-transactional-outbox-and-idempotent-consumer.md)                    | No dual write between Postgres and RabbitMQ. Costs a relay with a small publish delay, and duplicates that the consumer must absorb.                                                                                                                                     |
| [No saga](docs/adr/0005-no-saga.md)                                                                                           | One aggregate, one process: a state machine on the aggregate is enough.                                                                                                                                                                                                  |
| [Own RabbitMQ adapter](docs/adr/0006-own-rabbitmq-adapter.md)                                                                 | Two spikes compared a library and our own adapter under crash tests; both lost nothing; ours keeps every guarantee visible in a few hundred lines of our own code.                                                                                                       |
| [Idempotency-Key plus content hash](docs/adr/0007-idempotency-key-and-content-hash.md)                                        | Safe client retries, and a byte-identical resubmission is caught too. A business-level duplicate check (invoice number) is deferred.                                                                                                                                     |
| [OAuth2 client credentials, organisation from the token](docs/adr/0008-oauth2-client-credentials-and-organisation-scoping.md) | B2B machine clients; tenant isolation that a URL or body cannot override. Another organisation's document is a 404.                                                                                                                                                      |
| [Prisma for data access](docs/adr/0009-data-access-with-prisma.md)                                                            | The tool the developer knows best, so the fastest to deliver. It stays behind the ports, so swapping it is local.                                                                                                                                                        |
| [Hexagonal architecture, enforced](docs/adr/0010-hexagonal-architecture-with-enforced-dependency-rules.md)                    | The domain is framework-free and every adapter has an in-memory twin that passes the same contract tests.                                                                                                                                                                |
| [Documents in PostgreSQL behind a `BlobStore` port](docs/adr/0011-document-storage-in-postgresql-behind-blobstore-port.md)    | S3 was optional. With a 1 MiB limit, Postgres keeps the document in the same transaction as its event. An S3 adapter is a later step.                                                                                                                                    |
| [Problem Details, JSON](docs/adr/0012-problem-details-and-json-responses.md)                                                  | One error format with stable codes.                                                                                                                                                                                                                                      |
| [TLS at the edge (Caddy)](docs/adr/0013-tls-at-the-edge.md)                                                                   | HTTPS only, like behind a production load balancer: the services stay plain HTTP inside the network. Plain HTTP fails instead of redirecting, so no secret is sent in clear text first. Costs an extra container and a local CA that clients must trust (`pnpm tls:ca`). |

## Assumptions

- Clients are **B2B systems of organisations**, not people, so they authenticate with OAuth2 client
  credentials. The identity provider is mocked; production would use a real one.
- The concept is sized for about **1,000 documents a day**. That shaped the choices for one
  Postgres, an in-process rate limit and documents stored in the database.
- Only the Peppol BIS 3.0 **Invoice** is accepted. A `CreditNote` is rejected as "not supported yet".
- The submitting organisation is a party to the invoice: its Peppol ID is the supplier's or the
  customer's EndpointID. That decides whether it is a sales or a purchase invoice. Otherwise: `422 NOT_A_PARTY`.
- **"Processing"** means: the official EN 16931 and Peppol business rules, a VAT number check of the
  counterparty (a fake VIES adapter that can be unavailable or say "invalid"), and mapping to a
  canonical JSON invoice, which is the stored **result**.
- A duplicate is a **byte-identical file** per organisation. Recognising the same invoice in a
  different file needs a canonical model first and is deliberately left out.

## Security

- JWTs are verified against the IdP's JWKS: issuer, audience, expiry, and only `ES256`. Scopes per
  route; a route without a scope declaration fails closed.
- The organisation is taken from the token only. Another organisation's document answers `404`.
- XML: any DOCTYPE is rejected, external entities are never resolved and the parser never touches
  the network (`NONET | NO_XXE`). The body is read only after authentication, at most 1 MiB, UTF-8 only.
- HTTPS only, ending at a Caddy reverse proxy (the `edge`, [ADR 0013](docs/adr/0013-tls-at-the-edge.md)).
  The API and the mock IdP publish no ports of their own. Plain HTTP gets a `400`, never a
  redirect: a redirect would come only after the secret or token had been sent in clear text. The
  demo, the e2e tests and the curl examples verify the certificate against the exported CA;
  nothing switches verification off. The edge also limits request bodies, just above the API's
  1 MiB.
- The API trusts exactly one proxy hop (`TRUST_PROXY`, off by default), so a client cannot spoof
  its address with `X-Forwarded-For`. Responses carry `Strict-Transport-Security`: a year by
  default, five minutes in the compose stack (`HSTS_MAX_AGE_SECONDS`), so that a browser applying
  HSTS to `localhost` is not pinned to HTTPS for a year.
- Rate limit per organisation (120 requests a minute by default), helmet headers, no CORS.
- Logs contain IDs only: never XML content, amounts, VAT numbers or tokens (the `Authorization`
  header is redacted). Every log line carries the correlation id.
- No secrets in the repository; the containers run as a non-root user on a read-only filesystem.
- Dependencies are pinned exactly, must be at least 3 days old, install scripts are blocked by
  default, `pnpm audit` runs in CI and GitHub Actions are pinned to commit SHAs.

## Testing, CI/CD and monitoring

- **Unit tests:** the domain state machine (every state against every command), the command
  handlers with deterministic fault injection (crashes between commit and ack, relay crashes),
  validation against official-style fixtures, and the HTTP API with supertest.
- **Contract tests:** one suite per port runs against both the in-memory adapters and the real
  PostgreSQL and RabbitMQ adapters.
- **Walking skeleton:** the API and worker wiring end to end with in-memory adapters.
- **End-to-end tests:** the full Docker Compose stack with real tokens, including RabbitMQ and
  PostgreSQL outages.
- **CI** (GitHub Actions): format, lint, types, architecture rules, audit, unit tests and build;
  the contract tests against service containers; the e2e tests against the compose stack.
- **Release:** multi-arch images (amd64 and arm64) to GHCR with an SBOM and provenance. A `v*.*.*`
  tag publishes semver tags; Dependabot proposes updates.
- **Monitoring today:** structured JSON logs (pino); a correlation id per request that is echoed
  in the response, stored with every event and carried in the message headers into the worker;
  `GET /health`; and the RabbitMQ management UI (queue depths, the DLQ). Metrics and tracing are a
  next step.

## Next steps

In rough order of value for production:

1. **Operations for the unhappy path, part two:** alerts on the sweeper's warnings and on the DLQ
   depth, a cap on sweeper requeues per document (a poison document is now retried about every 20
   minutes), and a policy that lifts the DLQ's default delivery limit
   ([ADR 0014](docs/adr/0014-recovering-stuck-documents.md)).
2. **Metrics and tracing** (OpenTelemetry): outbox lag, queue depth, processing time, failures per
   rule; trace context carried in the message headers.
3. **Object storage:** an S3 adapter for the `BlobStore` port, written through the outbox so the
   transaction guarantee stays ([ADR 0011](docs/adr/0011-document-storage-in-postgresql-behind-blobstore-port.md)).
4. **Credit notes**, then a canonical model with an anti-corruption layer for other formats, which
   also enables a business-level duplicate check.
5. **Scaling out:** a shared rate-limit store (Redis), and more worker replicas (the relay and the
   consumer are already safe to run several times).
6. **The real VIES service** with a timeout and a circuit breaker; webhooks so clients need not poll.
7. Clarify the licence of the Peppol Schematron before publishing images that contain the compiled rules.

## AI usage

I built this with Claude Code (Claude Opus 5.5): a coordinating session for the design, the
foundation, reviews and documentation, subagents for the spikes, and one `/goal` session per work
package in its own git worktree. Every work package came in as a pull request that had to pass CI
and a review against the decisions before it was merged.

The details are in [docs/ai-usage.md](docs/ai-usage.md): the tools, where AI was used, what I
changed or corrected, which suggestions I deliberately did not adopt, how the output was verified,
and the time spent.
