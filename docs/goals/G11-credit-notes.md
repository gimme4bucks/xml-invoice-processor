# G11: Credit notes

**Goal:** accept Peppol BIS Billing 3.0 **credit notes** (UBL 2.1 `CreditNote`) next to invoices,
and show how little has to change to add a document type. Today a credit note is rejected at
intake with `unsupported-document-type`.

## Context

Read `CLAUDE.md` (including **Test-driven development**), ADR 0001, ADR 0002, ADR 0011 and the
validation adapters in `apps/service/src/documents/adapters/outbound/validation/`. The design
was prepared for this:

- `DocumentType` exists in the domain and the read model (`document_type`).
- The structure validator returns the type.
- The CEN XSLT and the Peppol Schematron cover `Invoice` and `CreditNote` in the same rules.

Facts to respect:

- A UBL credit note has its own root and namespace, `CreditNoteLine` with `CreditedQuantity` and a `CreditNoteTypeCode` (BT-3, for example 381).
- Its amounts are normally **positive**; the document type says that it credits.
- It may refer to the invoice it corrects (`BillingReference`, BT-25).

G10 (chaos tests) runs at the same time in new files under `test/chaos`. Do not touch those.

## Owned paths

- `apps/service/src/documents/**` (the domain, application and adapters for the document type)
- `apps/service/validation-artifacts/ubl-2.1/**` and `manifest.json`: add `xsdrt/maindoc/UBL-CreditNote-2.1.xsd` **unmodified** from the same OASIS UBL 2.1 OS package, with its sha256 (the manifest's `source` and `sourceSha256` stay the same)
- `apps/service/scripts/validation/**` (only if the SEF build needs it)
- `apps/service/test/fixtures/peppol/**`, `apps/service/test/unit/**`, `apps/service/test/contract/**`, `apps/service/test/e2e/documents.e2e.spec.ts`
- `scripts/demo/**`, `examples/**`
- **Contract changes, allowed here and to be called out in the PR:**
  - `domain/document-events.ts` (if an event needs the type);
  - `application/ports/**` (if the mapper port must return a credit note);
  - `test/contracts/**`.
- `README.md`: the API table, the decisions table and **Next steps** item 4; `docs/adr/0015-credit-notes.md` (new); `THIRD-PARTY-NOTICES.md` (the added XSD)

## Scope

1. **Intake:** a `CreditNote` root in its namespace passes the DOCTYPE ban and XSD validation against `UBL-CreditNote-2.1.xsd`. The document type is `CreditNote`. Any other root is still rejected as before.
2. **Worker:**
   - The official CEN and Peppol rules run on credit notes too, and a fatal violation still means `Failed`.
   - The mapper produces a canonical result for a credit note: lines from `CreditNoteLine`/`CreditedQuantity`, the type code, and the preceding invoice reference when present.
   - Purchase vs sales is derived as for invoices.
   - The VIES check is unchanged.
3. **API:**
   - `documentType` is `Invoice` or `CreditNote` in every response, and in OpenAPI.
   - `GET /documents` can filter by `type` if that is a small change; otherwise list it as an open point.
4. **Fixtures:**
   - Write the credit notes yourself, as `credit-note.xml` already is: no OpenPeppol examples, because their licence is unclear.
   - You need a valid one that passes the official rules, and one that violates a rule. A credit-note-specific rule is preferred; otherwise a BR-CO calculation rule.
5. **Demo and examples:** the demo's credit-note step goes from "rejected" to processed and `Completed`, and `examples/` documents it.
6. **Docs:**
   - ADR 0015: what changed per layer, and why the rest did not have to change.
   - README.
   - THIRD-PARTY-NOTICES.

## Test-driven

Red, green, refactor, at the lowest level that shows each behaviour:

- the structure validator accepts a valid credit note and still rejects other roots;
- the mapper's credit note result;
- the Schematron verdicts on both credit note fixtures (needs the SEFs, which are in the worktree);
- the handler completes a credit note against the in-memory adapters;
- the e2e test that expected a rejection now expects `Completed`. Change it first, and show it red.

## Acceptance criteria

- The PR's commits put each red test before its implementation, and **How verified** shows the red and the green runs.
- `pnpm verify` exits 0 (the Schematron specs run, not skipped).
- `pnpm e2e` and `pnpm demo` pass against the rebuilt stack.
- `pnpm -F @xip/service build:validation` still verifies every committed file against the manifest.
- A PR is open (`feat: accept Peppol BIS credit notes`), and its CI is green.

## Your infrastructure

G10 runs its chaos tests on the default compose project the whole time, and Colima has only 2 GB
of memory. The issuer contains the edge's fixed ports, so a second full stack cannot run beside
it. So:

- Use `pnpm test` and the contract tests against your own **infra** project. The worktree's `.env` sets `COMPOSE_PROJECT_NAME=xip-g11` with Postgres on 55432 and RabbitMQ on 55672/55673.
- Never start the `full` profile and never touch the `xml-invoice-processor` project.
- The PR's CI `e2e` job runs the e2e tests and `pnpm demo` against the full stack. That is your e2e evidence: show `gh pr checks` and the relevant lines of the job log (`gh run view --log`).

## /goal condition

```
/goal Work package G11 in docs/goals/G11-credit-notes.md is done: a Peppol BIS 3.0 CreditNote passes intake (XSD from the unmodified UBL 2.1 CreditNote schema, recorded in the manifest), runs through the official CEN and Peppol rules in the worker and ends Completed with a canonical credit note result, while a credit note violating a rule ends Failed; documentType is Invoice or CreditNote in the API; the demo and examples show a credit note being processed; ADR 0015, the README and THIRD-PARTY-NOTICES are updated; you followed red-green-refactor from CLAUDE.md (red tests committed before their implementation, red and green runs shown); `pnpm verify` exited 0 with the Schematron specs running (show the tail); and you opened a PR to main with `gh pr create` whose CI (including e2e and the demo) is green (show the URL and `gh pr checks`). Follow CLAUDE.md, do not add npm dependencies, never commit the Peppol .sch. Or stop after 90 turns and report what is missing.
```
