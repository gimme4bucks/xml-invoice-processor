Date: 2026-11-12

Question: Can a NestJS service on Node 22 validate incoming Peppol BIS Billing 3.0 (UBL 2.1) invoices in-process? That means XSD validation with a WASM libxml2, plus the official EN 16931 and Peppol Schematron rules run via SaxonJS 2.7. Or do we need to fall back to hand-coding the BR-CO calculation rules in TypeScript?

---

# Spike report: Peppol BIS 3 / EN 16931 validation in Node 22 (about 45 min)

Spike dir: `<scratch>/spike-validation` (called SPIKE below). It contains `scripts/` (my code, package.json, node_modules), `downloads/<one subdir per artifact>/` (untrusted downloads, only fed to the validators) and `work/` (inputs, SEFs, raw outputs `*.out`).

**Incident:** I briefly created 3 stray empty or test XML files in `<repo>` because a `cd` was missing: `xxe.xml`, `bad-totals.xml`, `bad-xsd-missing-issuedate.xml`. I deleted them straight away. `git status` there is clean again, and nothing else in that repo was touched.

## Verdicts
- **XSD layer: works.** Use **libxml2-wasm**, not xmllint-wasm. Both validate correctly against the full UBL 2.1 import graph (Invoice xsd plus 14 common xsds).
  - xmllint-wasm wraps the CLI: it starts a new Worker and re-parses the whole schema set on every call, about 69 ms per invoice.
  - libxml2-wasm compiles the schema once (56 ms) and then takes 0.14–0.3 ms per invoice. RSS stayed flat over 40,000 validations. *Verified.*
- **Schematron layer: works with caveats.** SaxonJS 2.7 compiles and runs the official CEN EN16931-UBL XSLT. The Peppol rules work too, but Peppol publishes only `.sch` with no precompiled XSLT, so there is one extra build step: transpile with SchXslt2 (pure XSLT 3.0, MIT), which runs fine under xslt3.
  - **Official CEN unit tests (validation-1.3.16, 277 files): 1133/1133 expectations pass.**
  - **Official Peppol unit tests (3.0.22, 153 files): 686/687 pass.** *Verified.*
  - The one failure is a **real SaxonJS 2.7 bug:** `mod` on an `xs:integer` above 2^53 is computed in doubles. Example: `xs:integer('512108001245126199131475') mod 97` gives 83; the correct answer is 1. Only DE-R-019 and DE-R-020 hit this (IBAN check, flag=warning, German-to-German invoices only). The CEN rules have no `mod` at all, and the other Peppol checksums use small numbers.
  - Mitigation: drop or recheck DE-R-019/020 in TypeScript.
- **Recommendation: go with SaxonJS plus the official artifacts.** The hand-coded BR-CO fallback isn't needed.
- **Main caveat is performance on large invoices**, covered under Timings.

## Exact commands and code (all run)
- **Build step:** `SPIKE/scripts/build-sef.sh`
  ```
  xslt3 -t -xsl:EN16931-UBL-validation.xslt -export:cen-en16931-ubl.sef.json -nogo -relocate:on
  xslt3 -xsl:schxslt2/transpile.xsl -s:PEPPOL-EN16931-UBL.sch -o:peppol-en16931-ubl.xslt
  xslt3 -t -xsl:peppol-en16931-ubl.xslt -export:peppol-en16931-ubl.sef.json -nogo -relocate:on
  ```
- **XSD module:** `SPIKE/scripts/lib/xsd-libxml2.mjs`
  - Registers every xsd in an `XmlBufferInputProvider` under the virtual paths `/ubl-2.1/{common,maindoc}/…`.
  - Parses the main xsd with `url:'/ubl-2.1/maindoc/UBL-Invoice-2.1.xsd'` so that relative `../common/…` imports resolve, then calls `XsdValidator.fromDoc` once.
  - Per request: `XmlDocument.fromBuffer(buf,{option: NONET|NO_XXE})`, then checks `doc.dtd` (rejects any DOCTYPE), checks `doc.root.name` / `doc.root.namespaceUri`, calls `validator.validate(doc)` and reads `XmlValidateError.details[{message,line,col}]`, then `doc.dispose()`.
- **xmllint-wasm alternative:** `SPIKE/scripts/lib/xsd-xmllint.mjs`. Preloaded `fileName` values may include directories, e.g. `common/X.xsd`.
- **Schematron module:** `SPIKE/scripts/lib/schematron.mjs`
  - Load each SEF once with `JSON.parse`.
  - Parse the invoice once with `SaxonJS.getResource({text,type:'xml'})` and reuse that node for both stylesheets.
  - Run `SaxonJS.transform({stylesheetInternal: sef, sourceNode, destination:'document'},'sync')`.
  - A single XPath, `array{ //(svrl:failed-assert|svrl:successful-report) ! map{'ruleId':string(@id),'flag':string(@flag),'location':string(@location),'message':normalize-space(svrl:text)…} }`, returns plain JS objects.
- **Drivers:** `run-all.mjs` (full pipeline), `peppol-unit-tests.mjs` (generic runner for the vefa testSet format), `bench.mjs`, `scale.mjs`, `xxe-probe.mjs`, `xsd-test.mjs`.

## Actual outputs (`SPIKE/work/run-all.out`, `run-bad-peppol.out`)
- **base-example.xml:** XSD ok, CEN 0 findings, Peppol 0. All 10 Peppol examples are clean.
- **(a) bad-totals** (LineExtensionAmount 1300→1400, PayableAmount→1600): XSD ok. CEN reports 3 fatal findings, all at `/ubl:Invoice[1]/cac:LegalMonetaryTotal[1]`: BR-CO-10, BR-CO-13 and BR-CO-16, with the official message text, e.g. "[BR-CO-10]-Sum of Invoice line net amount (BT-106) = Σ Invoice line net amount (BT-131)."
- **(b) missing cbc:IssueDate:** XSD fails at line 8: "Element '{…CommonBasicComponents-2}DueDate': This element is not expected. Expected is one of ( …CopyIndicator, …UUID, …IssueDate )." CEN also reports BR-03.
  - Note: the UBL XSD makes almost everything optional. Only ID, IssueDate, the two parties, LegalMonetaryTotal and InvoiceLine are mandatory, and element order is enforced.
- **(c) CreditNote:** libxml2-wasm gives `root={ns:'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2', name:'CreditNote'}`, and the code rejects it before the XSD step. Invoice root is `urn:…:Invoice-2` plus `Invoice`. Run as-is against the Invoice xsd it fails with "No matching global declaration available for the validation root". The CEN and Peppol XSLTs themselves handle both document types.
- **Extra Peppol case** (no BuyerReference, KVK EndpointID 0106 set to "1234"): fatal PEPPOL-EN16931-R003 at `/ubl:Invoice[1]`, plus warning PEPPOL-COMMON-R054 at `/ubl:Invoice[1]/cac:AccountingSupplierParty[1]/cac:Party[1]/cbc:EndpointID[1]`.

## Timings and memory (M-series Mac, Node 22.14; all measured)
- **One-off compile:**

| Step | Time | Peak RSS | SEF size |
|---|---|---|---|
| CEN xslt → SEF | 6.4 s | 580–690 MB | 6.8 MB (161 KB gzipped) |
| Peppol sch → xslt (SchXslt2) | 1.4 s | – | – |
| Peppol xslt → SEF | 4.8 s | 436 MB | 2.9 MB (81 KB gzipped) |

  - Transpiling CEN's `.sch` with SchXslt2 instead gives a 13 MB SEF, 17 s compile and about 55% slower runs, so use CEN's precompiled XSLT.
- **Startup:** XSD compile 56 ms (xsdrt; the full xsd with documentation takes 93 ms). JSON-parsing both SEFs takes 51 ms.
- **First (cold) transform:** CEN 128 ms, Peppol 36 ms.
- **Process memory:**
  - Plain node is 37 MB RSS; importing saxon-js adds about 83 MB.
  - After loading everything: 179 MB. After warm runs: about 210–240 MB RSS (heap about 77–100 MB).
- **Warm per-invoice cost, 9 KB / 2 lines:** XSD 0.29 ms, SaxonJS parse 0.48 ms, **CEN 40 ms, Peppol 8.4 ms**.
- **Scaling by line count (CEN / Peppol):**

| Lines | CEN | Peppol |
|---|---|---|
| 10 | 99 ms | 26 ms |
| 50 | 271 ms | 82 ms |
| 100 | 495 ms | 223 ms |
| 200 | 963 ms | 720 ms |
| 400 | 1.9 s | 2.6 s |
| 800 | 3.8 s | **9.9 s** |

  - CEN grows linearly, about 4.7 ms per line.
  - Peppol grows roughly quadratically. The likely cause (inferred) is rule contexts such as `//cac:ClassifiedTaxCategory[//cac:AccountingSupplierParty/…]`, which SaxonJS doesn't optimise.

## Pinned versions and URLs (all downloaded; sha256 shown)

| Artifact | URL | sha256 | Use |
|---|---|---|---|
| UBL 2.1 OS | https://docs.oasis-open.org/ubl/os-UBL-2.1/UBL-2.1.zip | 60b80d76…86ed | the `xsdrt/` folder (runtime xsd without documentation: common/ 628 KB plus maindoc) |
| CEN | https://github.com/ConnectingEurope/eInvoicing-EN16931/releases/download/validation-1.3.16/en16931-ubl-1.3.16.zip | bafada01…da85 | `xslt/EN16931-UBL-validation.xslt` (sha256 39f9d282…fcbd) |
| Peppol | tag **3.0.22** of https://github.com/OpenPEPPOL/peppol-bis-invoice-3 | – | `https://raw.githubusercontent.com/OpenPEPPOL/peppol-bis-invoice-3/3.0.22/rules/sch/PEPPOL-EN16931-UBL.sch` (sha256 f637444f…a148) |
| SchXslt2 | https://codeberg.org/SchXslt/schxslt2/releases/download/v1.11.2/schxslt2-1.11.2.zip | a0f5be31…af37c | `transpile.xsl` |

- Individual UBL xsds can be fetched directly, e.g. https://docs.oasis-open.org/ubl/os-UBL-2.1/xsdrt/maindoc/UBL-Invoice-2.1.xsd (returns 200).
- **Why CEN 1.3.16 and not the newer 1.3.17:** Peppol 3.0.22's bundled `rules/sch/CEN-EN16931-UBL.sch` is byte-identical to CEN 1.3.16's preprocessed sch (I diffed them). Its README wrongly says 1.3.14.1. CEN 1.3.17 (2026-10-12) also compiles, but don't use it with Peppol 3.0.22.
- **Peppol release status:**
  - 3.0.21 is the May 2026 release, mandatory from 2026-08-17. docs.peppol.eu/poacc/billing/3.0/files/ still serves 3.0.21.
  - 3.0.22 is a hotfix dated 2026-10-28 (RFC-607, only changes P0112 / Slovak 384) and is GitHub-only so far.
  - Peppol publishes only .sch files, no XSLT.
  - The SchXslt GitHub org is gone; SchXslt now lives on Codeberg.
- **npm** (installed with `--save-exact --ignore-scripts`):
  - `saxon-js@2.7.0`: runtime dependency. It pulls in axios.
  - `xslt3@2.7.0`: build-time only.
  - `libxml2-wasm@0.7.2`: MIT. It bundles libxml2 under its MIT licence.
  - `xmllint-wasm@5.3.0`: MIT, tested but not recommended. 6.0.0-rc.0 came out yesterday; avoid it.

## Licences (read by me; this is not legal advice)
- **saxon-js / xslt3:** identical LICENSE.txt, Saxonica proprietary "Version 1.0, June 2020", free of charge.
  - Allowed: run it on any machine, and redistribute it in unmodified binary form as part of an application. A Docker image that includes node_modules is fine.
  - Conditions: reproduce the copyright notice and disclaimer in your docs; no reverse engineering; don't use Saxonica's name for endorsement.
  - Not allowed: copying it "to a site whose primary purpose is to make it available to third parties".
  - It is **not OSI open source.** A public GitHub repo that only *depends* on it via package.json is fine. Don't vendor the package into the repo. Add a THIRD-PARTY-NOTICES entry.
  - The licence terminates if you bring patent litigation.
- **SchXslt2:** MIT.
- **UBL 2.1 XSDs:** © OASIS. The OASIS notice allows copying and distribution "without restriction of any kind" as long as the copyright notice is kept, and the files are not modified. Committing them unmodified is fine.
- **CEN artifacts:** EUPL-1.2 (copyleft, but it applies to the artifacts themselves). Committing them unmodified with the licence is fine. If you modify them, those modifications fall under EUPL. Using them as data in your service doesn't make your code EUPL (my inference).
- **Peppol BIS artifacts: unclear.**
  - The repo has no LICENSE file; the GitHub API reports `license: null`.
  - The .sch header says the CEN business terms are "reproduced with permission from CEN".
  - The BIS document says it "may not be modified, re-distribute[d], sold or repackaged… without the prior consent of OpenPeppol AISBL".
  - Committing it into a *public* repo is therefore a grey area. **Fetch it at build time from the pinned raw URL with a sha256 check** (or ask OpenPeppol). Don't patch it.

## Repo and layout recommendation
- Commit the UBL `xsdrt` folder (about 640 KB) and the CEN 1.3.16 XSLT plus its EUPL licence, unmodified, under `validation-artifacts/`.
- Fetch the Peppol .sch and SchXslt2 at build time with sha256 verification.
- Don't commit the SEFs: they embed `buildDateTime` and a checksum `Σ`, so they aren't reproducible across builds. Generate them in the Docker build stage. xslt3 and its roughly 600 MB to 1 GB of compile RAM stay in that stage.
- Suggested layout:
  - `validation-artifacts/{ubl-2.1/xsdrt/{common,maindoc}, en16931-1.3.16/{EN16931-UBL-validation.xslt,LICENSE-EUPL-1.2.txt}, manifest.json (urls+sha256)}`
  - `scripts/fetch-artifacts.ts`, `scripts/build-sef.sh`
  - Build output: `dist/validation/*.sef.json`
  - `src/validation/{xsd.validator.ts, schematron.validator.ts, svrl.ts}`

## Gotchas for the implementation agents
1. **Run all checks on raw bytes before Saxon.**
   - Parse with libxml2-wasm first, using `NONET|NO_XXE`, and **never** `XML_PARSE_NOENT`. With NOENT on, the probe showed it reads registered buffers through `SYSTEM` entities.
   - Reject when `doc.dtd` is set. Check the root namespace and name.
   - SaxonJS's own parser refuses unknown entities ("Reference to unknown entity &xxe;"), so it never expands them, but still reject DOCTYPE up front.
   - libxml2-wasm wasm memory is not garbage-collected: always `dispose()`.
2. **Event loop:** SaxonJS `transform(...,'sync')` blocks the event loop for 40 ms or more, and for seconds on large invoices. Run it in a worker_threads pool (e.g. piscina), with SEFs loaded once per worker (about 100 MB or more each, inferred). Add a cap on body size and line count, and a timeout.
3. **Load once:** load each SEF once and reuse the same `stylesheetInternal` object. Parse each invoice once and reuse the node for both CEN and Peppol.
4. **Locations come in two formats:**
   - CEN (ISO skeleton via ph-schematron): `/*:Invoice[namespace-uri()='…'][1]/*:LegalMonetaryTotal[namespace-uri()='…'][1]`.
   - Peppol (SchXslt2, `fn:path()`): `/Q{urn:…}Invoice[1]/Q{…}…[1]`.
   - `shortenLocation()` in schematron.mjs normalises both to `/ubl:Invoice[1]/cac:…`.
   - SVRL namespace: `http://purl.oclc.org/dsdl/svrl`.
5. **Flags:** `@flag` is `fatal` or `warning`. Reject only on fatal. Collect `svrl:successful-report` as well as `failed-assert`. The rule id is in `@id`, and the message text repeats it, e.g. `[BR-CO-10]-…`.
6. **Pairing:** CEN and Peppol rule sets are complementary (Peppol has no BR-CO checks), so run both, and keep the CEN version paired with what the Peppol release bundles.
7. **Known SaxonJS bug:** big-integer `mod` produces false DE-R-019/020 warnings. Decimal arithmetic was correct in my checks.
8. **No reference comparison:** Java isn't installed here, so parity is shown via the official unit-test suites, not by diffing against Saxon-HE output.

## Verified vs inferred
Everything above was run unless marked "inferred". The inferred points are:
- the cause of the Peppol quadratic scaling;
- worker-pool memory per worker;
- the licence interpretations;
- that a dependency-only public repo is fine under the Saxonica licence.
