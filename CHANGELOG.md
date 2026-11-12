# Changelog

All notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

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
