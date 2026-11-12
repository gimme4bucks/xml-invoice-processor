# 0001. Peppol BIS Billing 3.0 with the official EN 16931 and Peppol rules via SaxonJS

Status: Accepted (2026-11-12)

## Context

The service needs a concrete invoice format. The AI first proposed a simplified XSD of our own; the developer steered us towards Peppol BIS Billing 3.0, which had come up in an earlier conversation. Peppol BIS Billing 3.0 is UBL 2.1 XML (`Invoice` and `CreditNote` are separate root elements) and a CIUS of EN 16931. Peppol is also a network (four-corner model, Access Points, AS4); we use only the format.

The UBL 2.1 XSDs cover the structure. The business rules, such as the BR-CO calculation rules, are published as Schematron, which needs an XSLT 2/3 engine. We first planned to hand-code a subset of these rules, because the AI had said an XSLT 2 engine was hard to run in Node. The developer challenged that and asked about SaxonJS, and the AI corrected itself: SaxonJS runs as a library inside Node. A timeboxed spike then had to show that it runs the official artefacts, with the hand-coded subset as the fallback.

## Decision

- **Document type.** We accept Peppol BIS Billing 3.0 UBL 2.1 `Invoice` documents.
  - A `CreditNote` is rejected with a clear "document type not (yet) supported" error.
  - The design already has one strategy per document kind, so credit notes can be added later.
- **Structure.** We validate against the official OASIS UBL 2.1 XSDs (`xsdrt`), using `libxml2-wasm` 0.7.2.
- **Business rules.** We use the official CEN EN 16931 UBL rules 1.3.16 (precompiled XSLT) and the Peppol 3.0.22 Schematron, transpiled with SchXslt2 1.11.2.
  - At build time, both are compiled to SEF with `xslt3` 2.7.0. At runtime they run on `saxon-js` 2.7.0.
  - CEN 1.3.16 is the version that Peppol 3.0.22 bundles, so we do not use CEN 1.3.17.
- **Rule output.** The SVRL output is mapped to Problem Details with the official rule IDs ([ADR 0012](0012-problem-details-and-json-responses.md)).
  - Only `fatal` findings reject a document; warnings are reported.
  - DE-R-019 and DE-R-020 are filtered out and documented, because of a SaxonJS bug in big-integer `mod`.
- **Mapping.** There is one mapping from UBL to our domain model.
- **Licensing:**
  - SaxonJS is free but proprietary. It is only a dependency, never vendored, and gets a THIRD-PARTY-NOTICES entry.
  - The UBL XSDs and the CEN artefacts are committed unmodified.
  - The Peppol `.sch` has no clear licence, so it is fetched at build time from a pinned URL with a sha256 check.
  - SEFs are not committed, because they are not reproducible. They are generated in the Docker build stage.

Where each layer runs is decided in [ADR 0002](0002-split-validation-xsd-sync-schematron-async.md).

## Alternatives considered

- **Our own simplified invoice XSD** (the first AI proposal). Replaced by the real standard, at about one hour of extra work.
- **A hand-coded subset of the EN 16931 rules** (for example BR-CO-10 and BR-CO-15). This was the fallback; the spike showed it is not needed.
- **A Java validator (for example phive) in its own container.** Heavier on memory, and it conflicts with our assumption of a self-contained service.
- **`xmllint-wasm`.** Correct, but it re-parses the schema set on every call: about 69 ms per invoice.
- **`saxonjs-he` 3.0.0-beta2.** Still in beta.
- **Transpiling CEN's `.sch` with SchXslt2** instead of using its precompiled XSLT: a 13 MB SEF, a 17 s compile, and about 55% slower runs.

## Consequences

- We validate against the real standard and report official rule IDs, not our own approximation.
- Memory cost:
  - Importing SaxonJS adds about 83 MB to a process; RSS is about 210–240 MB after warm runs.
  - Compiling the SEFs needs 600 MB–1 GB of RAM in the build stage.
- We take on a proprietary runtime dependency and a Peppol artefact with an unclear licence, both handled as described above.
- Adding `CreditNote` support later takes a schema, a mapper and a strategy.

## Evidence

Source: [Spike 01](../spikes/01-validation.md).

- The official CEN unit tests (1.3.16, 277 files) pass 1133/1133 expectations.
- The official Peppol unit tests (3.0.22, 153 files) pass 686/687. The one failure is the SaxonJS `mod` bug, which affects DE-R-019/020: warnings, and only on German-to-German invoices.
- XSD validation with libxml2-wasm compiles the schema once (56 ms), then takes 0.14–0.3 ms per invoice. RSS stayed flat over 40,000 validations.
- Parity was shown with the official test suites, not by comparing output against Java Saxon-HE.

## Follow-ups

- Support for `CreditNote` (weekend work).
- Other formats (for example SI-UBL) through an anti-corruption layer to a canonical model.
- Optionally, re-check DE-R-019/020 in TypeScript.
- Optionally, ask OpenPeppol about redistributing its artefacts.
