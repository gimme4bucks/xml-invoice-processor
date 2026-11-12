# G02: Validation (XSD, Schematron, UBL mapping, VIES fake)

**Goal:** real implementations of `StructureValidator`, `InvoiceMapper`,
`BusinessRuleValidator` and a demo-grade `VatNumberVerifier`, built from the official
artifacts.

## Context

- Read `CLAUDE.md`, ADRs 0001 and 0002, and `docs/spikes/01-validation.md` (it has the pinned URLs and sha256 sums).
- Start from `docs/spikes/code/01-validation/`.

## Owned paths

- `apps/service/src/documents/adapters/outbound/validation/**`
- `apps/service/src/documents/adapters/outbound/vies/**`
- `apps/service/validation-artifacts/**`, `apps/service/scripts/validation/**`
- `apps/service/test/fixtures/peppol/**`
- `scripts` entries in `apps/service/package.json`
- `THIRD-PARTY-NOTICES.md`

## Scope

1. **Artifacts:**
   - commit the UBL 2.1 `xsdrt` schemas and the CEN EN16931 1.3.16 UBL XSLT, unmodified and with their licences;
   - add `manifest.json` with URLs and sha256 sums;
   - `scripts/validation/fetch-and-compile`: fetch the Peppol 3.0.22 `.sch` and SchXslt2 1.11.2 with sha256 verification, transpile them, and compile both SEFs with xslt3 into `validation-artifacts/generated/` (gitignored);
   - add the `build:validation` script.
2. **`LibxmlStructureValidator`:**
   - parse with `NONET | NO_XXE` (never `NOENT`);
   - reject a DOCTYPE (`doctype-forbidden`);
   - a CreditNote root gives `unsupported-document-type`; any other non-Invoice root gives `schema-invalid`;
   - validate against the compiled XSD (compile once) and return errors with line and column;
   - always `dispose()`.
3. **`UblInvoiceMapper`:**
   - libxml2 XPath with UBL namespaces, mapping to `CanonicalInvoice`: parties with EndpointID scheme + value as `PeppolParticipantId`, VAT number from `PartyTaxScheme/CompanyID`, lines, totals and dates;
   - amounts stay decimal strings.
4. **`SchematronBusinessRuleValidator`:**
   - a piscina pool; each thread loads the CEN and Peppol SEFs once and parses the XML once for both;
   - configurable pool size and timeout;
   - SVRL to `RuleViolation[]`, with locations normalised to `/ubl:Invoice[1]/…`;
   - drop DE-R-019/DE-R-020 (SaxonJS big-integer `mod` bug) and document why.
5. **`FakeViesVerifier`:**
   - deterministic and configurable through env: `VIES_UNAVAILABLE_RATE` (0–1), `VIES_INVALID_VAT_NUMBERS` (comma list) and `VIES_UNAVAILABLE_TIMES_PER_NUMBER` (so a demo can show "fails twice, then succeeds");
   - it throws `VatServiceUnavailableError` when unavailable;
   - this is the "peripheral systems may be mocked" assumption.
6. **Fixtures:** write our own Peppol invoices; do **not** copy OpenPeppol examples, which have no licence. Include:
   - a valid sales invoice and a valid purchase invoice;
   - bad totals, which must trigger BR-CO-10/13/16;
   - a missing IssueDate (XSD error), a DOCTYPE/XXE attempt, a CreditNote, and a 300-line invoice for timing.
7. **Export `validationProviders(): Provider[]`** for G07 (do not edit `src/app/*`).
8. Add `THIRD-PARTY-NOTICES.md` (SaxonJS licence notice, OASIS UBL, CEN EUPL-1.2, SchXslt2 MIT).

## Out of scope

The composition root, HTTP, the Dockerfile (G06 calls `build:validation`).

## Acceptance criteria

- Unit tests (`*.spec.ts` next to the adapters) prove every fixture outcome, the XXE rejection, the CreditNote rejection, the DE-R filter, the timeout and the fake VIES behaviours.
- `pnpm -F @xip/service build:validation` works from a clean checkout.
- `pnpm verify` exits 0.
- Only owned paths changed.
- A PR is open (`feat(validation): …`).

## /goal condition

```
/goal Work package G02 in docs/goals/G02-validation.md is done: LibxmlStructureValidator, UblInvoiceMapper, SchematronBusinessRuleValidator (piscina, timeout, DE-R-019/020 filtered) and FakeViesVerifier exist with an exported validationProviders(); artifacts are committed or fetched with sha256 checks as the goal file says; you ran `pnpm -F @xip/service build:validation` from a clean state and it succeeded (show the tail); the unit tests for all fixtures (valid, bad totals BR-CO, XSD error, DOCTYPE, CreditNote) pass in `pnpm verify`, which exited 0 (show the tail); `git diff --stat origin/main...HEAD` (shown) touches only the owned paths; and you opened a PR to main with `gh pr create` (show the URL). Follow CLAUDE.md, do not add dependencies, never commit the Peppol .sch. Or stop after 60 turns and report what is missing.
```
