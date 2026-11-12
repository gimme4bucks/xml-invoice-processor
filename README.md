# xml-invoice-processor

A backend that receives **Peppol BIS Billing 3.0 invoices (UBL 2.1 XML)** from B2B systems over
HTTP, validates them, stores them without ever losing an accepted document, and processes them
asynchronously, with a status per document (`Received`, `Processing`, `Completed`, `Failed`).

> **Status:** work in progress. The foundation and walking skeleton are in place; the real
> adapters are being built as separate work packages (see [docs/goals](docs/goals/)).
> This README is completed with the first release.

- Architecture decisions: [docs/adr](docs/adr/)
- Spikes (measured evidence behind the decisions): [docs/spikes](docs/spikes/)
- Working agreements for humans and AI agents: [CLAUDE.md](CLAUDE.md)
