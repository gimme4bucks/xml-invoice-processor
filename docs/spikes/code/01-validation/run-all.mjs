// usage: node run-all.mjs <xsdRoot> <cen.sef.json> <peppol.sef.json> <xml files...>
// Runs XSD (libxml2-wasm) + Schematron (SaxonJS, CEN + Peppol) on each file and prints the findings.
import fs from 'node:fs';
import path from 'node:path';
import { createUblXsdValidator } from './lib/xsd-libxml2.mjs';
import { loadSef, parseForSaxon, runSchematron } from './lib/schematron.mjs';

const [xsdRoot, cenSefFile, peppolSefFile, ...files] = process.argv.slice(2);
const ms = (t) => Number(process.hrtime.bigint() - t) / 1e6;
const rss = () => `${(process.memoryUsage().rss / 2 ** 20).toFixed(0)} MiB`;

console.log(`startup rss=${rss()}`);
let t = process.hrtime.bigint();
const xsd = createUblXsdValidator(xsdRoot);
console.log(`XSD compiled in ${ms(t).toFixed(0)} ms, rss=${rss()}`);
t = process.hrtime.bigint();
const cen = loadSef(cenSefFile);
const peppol = loadSef(peppolSefFile);
console.log(`SEFs JSON-loaded in ${ms(t).toFixed(0)} ms, rss=${rss()}`);

for (const f of files) {
  const buf = fs.readFileSync(f);
  console.log(`\n================ ${path.basename(f)}`);
  const x = xsd.validate(buf);
  console.log(`XSD: ok=${x.ok} root=${x.root ? x.root.name : '-'}`);
  for (const e of x.errors) console.log(`   [${e.stage}] line ${e.line ?? '-'}: ${e.message}`);
  // For the spike we run Schematron even if XSD failed, to show what it reports (the service would stop at XSD).
  if (x.errors.some((e) => e.stage === 'doctype' || e.stage === 'parse')) continue;
  const node = await parseForSaxon(buf.toString('utf8'));
  for (const [name, sef] of [['CEN', cen], ['PEPPOL', peppol]]) {
    t = process.hrtime.bigint();
    const res = runSchematron(sef, node);
    const fatal = res.filter((r) => r.flag === 'fatal').length;
    console.log(`${name}: ${res.length} findings (${fatal} fatal) in ${ms(t).toFixed(0)} ms`);
    for (const r of res) console.log(`   ${r.flag.padEnd(7)} ${r.ruleId.padEnd(16)} ${r.location}\n           ${r.message.slice(0, 220)}`);
  }
}
console.log(`\nfinal rss=${rss()}`);
