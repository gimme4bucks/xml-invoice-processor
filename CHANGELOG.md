# Changelog

All notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **HTTPS at the edge** ([ADR 0013](docs/adr/0013-tls-at-the-edge.md)):
  - A Caddy reverse proxy terminates TLS for the API (`https://localhost:3443`) and the mock IdP (`https://localhost:4443`), with a local CA.
  - `pnpm tls:ca` exports the CA, and the demo and e2e tests trust it explicitly.
  - Plain HTTP is refused, not redirected.
  - The API trusts exactly one proxy hop (`TRUST_PROXY`).
  - The HSTS max-age is configurable (`HSTS_MAX_AGE_SECONDS`).
- **Recovering stuck documents** ([ADR 0014](docs/adr/0014-recovering-stuck-documents.md)):
  - `xip redrive [--dry-run] [--limit N]` requeues dead-lettered documents through the outbox.
  - A sweeper in every worker requeues documents that stay unchanged too long.
  - Both record `ProcessingRequeued` in the document's history.
- **Worker logs:** one JSON line per handled message, with IDs, attempt, outcome, duration and correlation id.
- **Test-driven development** (red, green, refactor) is a hard rule for every work package (`CLAUDE.md`).

### Changed

- **Ports:** the full compose stack publishes only the edge's HTTPS ports. The API and the mock IdP no longer listen on host ports 3000 and 4000.
- **Dependencies:** NestJS 12.4.2, Vite 8.3.7, jose 6.2.17 and typescript-eslint 8.72.2.

## [1.0.0] - 2026-11-12

The first release: a working backend that receives Peppol BIS Billing 3.0 invoices over HTTP,
validates them, stores them without loss and processes them asynchronously.

### Added

- **API** (`POST /documents`, `GET /documents`, `GET /documents/{id}`, `/result`, `/history`) with
  OAuth2 client-credentials JWTs, scopes, organisation scoping from the token, an
  `Idempotency-Key` plus content hash, RFC 9457 Problem Details with a stable code catalogue,
  rate limiting per organisation, helmet, structured logging with a correlation id, and OpenAPI.
- **Validation:** DOCTYPE ban and UBL 2.1 XSD at intake (libxml2-wasm); the official EN 16931
  (CEN 1.3.16) and Peppol BIS 3.0 (3.0.22) Schematron rules in the worker (SaxonJS in worker threads).
- **Processing:** an event-sourced `Document` aggregate in PostgreSQL with a read model updated in
  the same transaction, a transactional outbox with a relay, RabbitMQ quorum queues with retry
  delay queues and a dead-letter queue, an idempotent consumer, and a fake VIES VAT number check.
- **Mock identity provider** for development, the demo and the e2e tests.
- **Delivery:** one container image (API, worker, migrations) and a mock-idp image, multi-arch on
  GHCR with an SBOM and provenance; a Docker Compose stack; `pnpm demo`.
- **Tests and CI:** unit tests, port contract tests against in-memory and real adapters, a walking
  skeleton, end-to-end tests against the full stack including RabbitMQ and PostgreSQL outages,
  and enforced architecture rules.
- **Documentation:** README, twelve ADRs, the decision log, the spike reports and the AI usage log.

[1.0.0]: https://github.com/gimme4bucks/xml-invoice-processor/releases/tag/v1.0.0
