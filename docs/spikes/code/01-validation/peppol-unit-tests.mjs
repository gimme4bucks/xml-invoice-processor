// Run the official Peppol BIS unit tests (rules/unit-UBL-*/*.xml, vefa testSet format) against the
// Peppol SEF executed by SaxonJS, to check SaxonJS gives the same rule results the Peppol team expects.
// usage: node peppol-unit-tests.mjs <peppol.sef.json> <test files...>
import fs from 'node:fs';
import path from 'node:path';
import SaxonJS from 'saxon-js';
import { loadSef, runSchematron } from './lib/schematron.mjs';

const [sefFile, ...files] = process.argv.slice(2);
const sef = loadSef(sefFile);
const V = { v: 'http://difi.no/xsd/vefa/validator/1.0' };
let pass = 0, fail = 0;
const failures = [];

for (const f of files) {
  const set = await SaxonJS.getResource({ text: fs.readFileSync(f, 'utf8'), type: 'xml' });
  const tests = SaxonJS.XPath.evaluate('/v:testSet/v:test', set, { namespaceContext: V, resultForm: 'array' });
  tests.forEach((test, i) => {
    const expect = SaxonJS.XPath.evaluate(
      `array { v:assert/(v:success|v:error|v:warning) ! map { 'kind': local-name(), 'id': normalize-space(.), 'n': string(@number) } }`,
      test, { namespaceContext: V });
    const docEl = SaxonJS.XPath.evaluate('*[not(self::v:assert)][1]', test, { namespaceContext: V });
    // re-root the embedded document so absolute paths (/ubl:Invoice, /*/cbc:ProfileID) work
    const doc = SaxonJS.XPath.evaluate('parse-xml(serialize($e))', null, { params: { e: docEl } });
    const got = runSchematron(sef, doc);
    for (const e of expect) {
      const hits = got.filter((g) => g.ruleId === e.id);
      const fatal = hits.filter((g) => g.flag === 'fatal').length;
      const warn = hits.filter((g) => g.flag === 'warning').length;
      let ok;
      if (e.kind === 'success') ok = hits.length === 0;
      else {
        const cnt = e.kind === 'error' ? fatal : warn;
        ok = e.n ? cnt === Number(e.n) : cnt > 0;
      }
      if (ok) pass++;
      else { fail++; failures.push(`${path.basename(f)} test#${i + 1}: expected ${e.kind}${e.n ? '×' + e.n : ''} ${e.id}, got fatal=${fatal} warning=${warn}`); }
    }
  });
}
console.log(`Peppol unit-test expectations: ${pass} passed, ${fail} failed (files: ${files.length})`);
for (const x of failures.slice(0, 40)) console.log('  FAIL', x);
