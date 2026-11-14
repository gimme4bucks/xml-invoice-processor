# Changelog

All notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.2.0] - 2026-11-14

A public demo, and a login button in the Swagger UI so that testers need no curl.

### Added

- **Public demo deployment** ([ADR 0019](docs/adr/0019-public-demo.md), runbook in `deploy/demo/README.md`):
  - the full stack on one server behind real hostnames, with Let's Encrypt certificates over the TLS-ALPN challenge on port 443;
  - a compose override that publishes only the edge, points every URL, issuer, CORS origin and redirect URI to the public hosts, and takes every secret from a generated server-side `.env`;
  - a scripted check of the rendered configuration.
- **Swagger UI login:** an **Authorize** button with OAuth2 client credentials. Its token URL comes from `AUTH_TOKEN_URL`, and the mock IdP answers CORS on `/token` for the origins in `MOCK_IDP_CORS_ORIGINS`.
- **`pnpm demo` against any host:** it runs against public URLs (`API_BASE_URL`, `IDP_BASE_URL`) and then trusts the public CAs.

### Fixed

- **Image builds:** a dropped connection or reset stream while downloading the validation artifacts no longer fails the build at once. The download now retries every error, and the sha256 check still guards the content.

## [1.1.0] - 2026-11-13

The extras on top of v1.0.0:

- HTTPS at the edge.
- Tools that recover stuck documents.
- Credit notes.
- Documents in S3.
- A support view in the browser.
- Chaos tests that prove no document is lost or processed twice when infrastructure fails hard.

Every work package was built test-first.

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
- **Credit notes** ([ADR 0015](docs/adr/0015-credit-notes.md)):
  - Peppol BIS 3.0 credit notes (UBL 2.1 `CreditNote`) are validated against the unmodified UBL CreditNote XSD and the same official rules as invoices.
  - They are mapped into the canonical model, with the credited invoice as the preceding invoice reference.
  - `documentType` is `Invoice` or `CreditNote`, and `GET /documents?type=` filters on it.
  - The demo follows a credit note to `Completed`.
- **Documents in S3** ([ADR 0016](docs/adr/0016-documents-in-s3.md)):
  - `BLOB_STORE=postgres|s3`; the full compose stack uses S3, on a local Versity S3 Gateway.
  - Each object is uploaded under its sha256 before the transaction that references it commits, and every read checks the sha256.
  - An orphan collector in every worker removes objects that no transaction referenced, kept apart from uploads by advisory locks.
  - An object store outage answers 503 with `Retry-After`, like a database outage.
- **Support access** ([ADR 0017](docs/adr/0017-support-access-with-pkce.md)):
  - The mock IdP signs support staff in with Authorization Code + PKCE (public client `support-web`, S256 only).
  - With scope `support:read`, `GET /support/documents`, `/{id}` and `/{id}/history` read across organisations. They never return the XML or the result.
  - Every support request writes an audit line.
  - Support tokens are rate-limited per user.
  - CORS is off unless `CORS_ORIGINS` names the frontend's origin.
- **Support view in the browser** ([ADR 0018](docs/adr/0018-support-web-app.md)):
  - A React app at `https://localhost:5443`. Support staff sign in with Authorization Code + PKCE, and the token is kept in memory only.
  - It shows the document list across organisations, with filters and paging, and a detail view with failure reasons and history.
  - A strict CSP whose `connect-src` names only the API and the IdP, configured at runtime.
  - A third image, `xml-invoice-processor-web`: Caddy, non-root, with a read-only filesystem.
- **Chaos tests** (`pnpm test:chaos`, a separate CI job): five hard failure scenarios against the full stack over HTTPS. Each proves that no document is lost or processed twice:
  - a long Postgres outage, then `xip redrive`;
  - a lost message, recovered by the sweeper;
  - a killed worker;
  - a poison message;
  - a RabbitMQ kill during a burst.
- **Worker logs:** one JSON line per handled message, with IDs, attempt, outcome, duration and correlation id.
- **Test-driven development** (red, green, refactor) is a hard rule for every work package (`CLAUDE.md`).

### Changed

- **Organisation endpoints:** a token without `org_id` gets 403 `ORGANISATION_TOKEN_REQUIRED`. A token with neither `org_id` nor `peppol_id` used to get 401.
- **Blobs:** `blobs.content` is nullable, because with S3 the row holds only the reference (migration `20261113120000_blob_references`). The Postgres blob store now also checks the sha256 on read.

- **Ports:** the full compose stack publishes only the edge's HTTPS ports: 3443 (API), 4443 (IdP) and 5443 (support view). The API and the mock IdP no longer listen on host ports 3000 and 4000.
- **Dependencies:** NestJS 12.4.2, Vite 8.3.7, jose 6.2.17 and typescript-eslint 8.72.2. New: `@aws-sdk/client-s3` 3.1165.0, and React 19.3.1 for the support view.

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

[Unreleased]: https://github.com/gimme4bucks/xml-invoice-processor/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/gimme4bucks/xml-invoice-processor/releases/tag/v1.2.0
[1.1.0]: https://github.com/gimme4bucks/xml-invoice-processor/releases/tag/v1.1.0
[1.0.0]: https://github.com/gimme4bucks/xml-invoice-processor/releases/tag/v1.0.0
