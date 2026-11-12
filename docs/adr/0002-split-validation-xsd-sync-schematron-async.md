# 0002. Split validation: XSD synchronously at intake, Schematron asynchronously in the worker

Status: Accepted (2026-11-12)

## Context

[ADR 0001](0001-peppol-bis-billing-3-official-rules-saxonjs.md) gives us two validation layers:

- structure, checked against the UBL 2.1 XSD;
- business rules, checked with the EN 16931 and Peppol Schematron via SaxonJS.

Invalid documents must be rejected when they are submitted.

**This ADR revises an earlier decision from the same session.** We had first decided to run both layers synchronously at intake, so that, for example, a totals mismatch would be rejected immediately. That decision rested on an AI assumption: that running Schematron synchronously would cost no noticeable performance.

Even before that, the developer had suggested running SaxonJS somewhere separate from the API. The AI answered that it could run in-process in the API. That was technically correct, but it missed the point of keeping heavy computation out of the API. Spike 01 then measured the actual cost.

## Decision

**Synchronous, in the API process (cheap checks):**

- a body-size limit of 1 MB, checked before parsing (413);
- Content-Type `application/xml` only (415), and UTF-8 only;
- any DOCTYPE is rejected;
- a root check: `Invoice` is accepted, while `CreditNote` is rejected as "not yet supported";
- XSD validation with libxml2-wasm, which takes under 1 ms.

This covers the assignment's structural validation step. A failure is returned directly as a 4xx with the XSD errors, including line and column.

**Asynchronous, in the worker process:**

- The CEN EN 16931 and Peppol Schematron run via SaxonJS in a `worker_threads` pool (piscina), with a timeout and no line-count cap.
- A `fatal` violation is a permanent failure: the document goes to `Failed` with the list of rule IDs and messages.
- After that, the VIES VAT-number check runs. Permanent errors lead to `Failed`, and transient errors are retried through the outbox.

The API process does not load SaxonJS. Documents that fail rule validation stay stored, together with the reason.

## Alternatives considered

- **Both layers synchronous** (the earlier decision). We dropped it after the spike: the Peppol rules scale roughly quadratically with the number of lines, and the synchronous transform blocks the event loop.
- **Synchronous Schematron, offloaded to a worker-thread pool inside the API, with a line-count cap and a timeout.** This is what the spike suggested for a synchronous path. We preferred to keep the heavy computation out of the API entirely.
- **A separate validation component next to the API** (the developer's original idea). Running the rules in the worker process gives the isolation that idea was after.

## Consequences

- A structurally valid invoice gets a 202 even if it breaks a business rule. The client sees `Failed`, with the rule IDs, when it polls the status. A totals mismatch is no longer rejected synchronously.
- The API stays light, and a large invoice can take seconds in the worker without blocking the API.
- Each worker thread loads its own copy of the SEFs. The spike's estimate is about 100 MB or more per thread (inferred, not measured).
- The e2e scenarios reflect the split. An XSD error gives a direct rejection, while a Peppol rule violation ends in `Failed` with rule IDs.

## Evidence

From [Spike 01](../spikes/01-validation.md), measured warm on Node 22.14:

- **Small invoice** (9 KB, 2 lines): XSD 0.29 ms, CEN 40 ms, Peppol 8.4 ms.
- **First (cold) transform:** CEN 128 ms, Peppol 36 ms.
- **Scaling by line count:**

  | Lines | CEN    | Peppol |
  | ----- | ------ | ------ |
  | 10    | 99 ms  | 26 ms  |
  | 50    | 271 ms | 82 ms  |
  | 100   | 495 ms | 223 ms |
  | 200   | 963 ms | 720 ms |
  | 400   | 1.9 s  | 2.6 s  |
  | 800   | 3.8 s  | 9.9 s  |

  CEN grows linearly, at about 4.7 ms per line. Peppol grows roughly quadratically.

- `SaxonJS.transform(..., 'sync')` blocks the event loop for 40 ms or more, and for seconds on large invoices.

## Follow-ups

- Worker pool size and timeout, settled during implementation (work package G02):
  - `SCHEMATRON_POOL_SIZE=2` threads, each holding both compiled rule sets (100 MB or more per thread).
  - `SCHEMATRON_TIMEOUT_MS=30000` per invoice. The timeout measures the run itself: a small semaphore hands an invoice to the pool only when a thread is free, so waiting behind other invoices never counts.
  - A timeout is a permanent `Failed` with rule id `XIP-SCHEMATRON-TIMEOUT`. The same document would time out again, so retrying would only use up the delivery limit and leave it in `Processing`.
- SaxonJS is loaded only inside the worker threads, and the pool starts on the first validation, so the API process never pays for it. Both processes do check at startup that the compiled rule sets exist.
