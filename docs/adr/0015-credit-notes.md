# 0015. Credit notes

Status: Accepted (2026-11-13)

## Context

Peppol BIS Billing 3.0 has two documents: the invoice and the credit note. Until now intake
rejected a `CreditNote` with `422 DOCUMENT_REJECTED`, reason `unsupported-document-type`
(decision log 2.8). This ADR records how they are accepted, and which parts of the design did not
have to change.

Facts that shaped the decision:

- **UBL 2.1** (the syntax) gives a credit note its own root element and namespace
  (`urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2`), its own main schema
  (`UBL-CreditNote-2.1.xsd`), its own lines (`cac:CreditNoteLine` with `cbc:CreditedQuantity`)
  and its own type code element (`cbc:CreditNoteTypeCode`, BT-3, for example 381).
- **EN 16931** (the semantic model under Peppol) has one model for both. A credit note is an
  invoice whose type code credits. Its amounts are normally **positive**: the document type says
  that it credits. It may name the invoice it corrects (`cac:BillingReference`, BT-25 and BT-26).
- The **official rules** already cover both roots: the CEN XSLT and the Peppol Schematron contain
  credit-note rules, such as `PEPPOL-EN16931-P0101` (the credit note type code must be one the
  profile allows) and `BR-CL-01` (the type code list).
- The design was prepared for it: `DocumentType` exists in the domain, in `DocumentReceived` and in
  the read model (`document_type`), and the structure validator already returned the type.

## Decision

**A credit note goes through exactly the same pipeline as an invoice.** What changed, per layer:

| Layer                                        | Change                                                                                                                                                                                                                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Validation artifacts                         | `xsdrt/maindoc/UBL-CreditNote-2.1.xsd`, copied **unmodified** from the same OASIS UBL 2.1 OS archive, with its sha256 in `manifest.json`. The common schemas it imports were already committed. `build:validation` verifies it like every other committed file.                      |
| Intake (`LibxmlStructureValidator`)          | One compiled XSD per accepted root. The root's name and namespace choose the schema and the `documentType`. Any other root is still `schema-invalid`.                                                                                                                                |
| Domain                                       | `DocumentType = 'Invoice' \| 'CreditNote'`. The canonical model becomes `CanonicalDocument = CanonicalInvoice \| CanonicalCreditNote`. They share every field except the number (`invoiceNumber` or `creditNoteNumber`). Both gain `typeCode` (BT-3) and `precedingInvoices` (BG-3). |
| Mapper (`UblInvoiceMapper`, anti-corruption) | A small syntax table per root: type code element, line element, quantity element. Every other XPath is the same for both, now relative to the root.                                                                                                                                  |
| Worker (`ProcessDocumentHandler`)            | Only the result key: `invoice` or `creditNote`. The official rules, the purchase or sales derivation and the VIES check are unchanged.                                                                                                                                               |
| API                                          | `documentType` is `Invoice` or `CreditNote` in every response and in OpenAPI. `GET /documents?type=` filters on it, next to `status`.                                                                                                                                                |

**What did not change, and why:**

- **The aggregate, its events and the state machine.** `DocumentReceived` already carried
  `documentType`, and a credit note has the same lifecycle as an invoice.
- **Persistence, the outbox, messaging and the retry path.** They move document ids, never
  document content.
- **Idempotency.** The content hash is computed over any bytes; a credit note is another file.
- **Authorisation and the direction.** Both only read the supplier's and the customer's
  EndpointID, which sit in the same place in both roots.
- **The business rules.** The official rule sets judge credit notes already; we only run them.

## Alternatives considered

- **One canonical model with `invoiceNumber` for both**, as EN 16931 names BT-1. It is the
  smallest change, but a client that reads `invoice.invoiceNumber` could book a credit note as an
  invoice. The two names make that mistake impossible, at the cost of one union member.
- **The credit note's result under `invoice`**, with `documentType` inside. No new key, but the
  key would be wrong for every credit note. A shared `document` key for both would break the
  invoice result that clients already read.
- **Negative amounts in the canonical credit note.** Rejected: the document has positive amounts,
  and flipping them would mean inventing data. A consumer decides the sign from `documentType`.
- **Removing the `unsupported-document-type` reason.** No validator produces it any more, but it is
  part of the public Problem Details enum. It stays reserved for the next document type that is
  recognised but not supported.

## Consequences and remaining risks

- Adding a document type touched one XSD, two small tables (the validator's roots and the
  mapper's syntax), a union member, a result key and an enum. The pipeline, persistence and
  messaging did not change: the separation that ADR 0002 and ADR 0010 bought paid off.
- Clients branch on `documentType` (or on the result key). Invoice results only gain fields
  (`documentType`, `typeCode`, `precedingInvoices`), so existing clients keep working.
- **The reference to the credited invoice is recorded, not checked.** A credit note for an
  invoice we never saw, or for more than that invoice's amount, still completes. That is a business
  check on top of the canonical model, like the business-level duplicate check of ADR 0007.
- The API compiles a second XSD at startup (both are compiled once and kept).
- `XIP-SCHEMATRON-TIMEOUT` still reports the location `/ubl:Invoice[1]`, also for a credit note.

## Evidence

- `libxml-structure-validator.spec.ts`: both credit note fixtures pass the CreditNote XSD, a credit
  note with invoice lines fails it, other roots are still rejected.
- `ubl-invoice-mapper.spec.ts`: the credit note's number, type code, credited lines and preceding
  invoice.
- `schematron-business-rule-validator.spec.ts`: no violations on `credit-note.xml`; fatal
  `PEPPOL-EN16931-P0101` and `BR-CL-01` on `credit-note-bad-type-code.xml`.
- `process-document.spec.ts` and `http-api.spec.ts`: the worker completes a credit note against the
  in-memory adapters, a purchase credit note gets the same VIES check, and the API filters by type.
- `persistence.contract.ts`: the type filter, against the in-memory adapter and PostgreSQL.
- `documents.e2e.spec.ts` and `pnpm demo`: against the full stack, a credit note ends `Completed`
  with its `creditNote` result, and one with type code 380 ends `Failed` on `PEPPOL-EN16931-P0101`.

## Follow-ups

- Check a credit note against the invoice it credits, once a business-level model of stored
  invoices exists.
- Rename the `InvoiceMapper` port to `DocumentMapper` (naming only).
