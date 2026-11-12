// usage: node bench.mjs <xsdRoot> <cen.sef.json> <peppol.sef.json> <invoice.xml>
import fs from 'node:fs';
import { createUblXsdValidator } from './lib/xsd-libxml2.mjs';
import { loadSef, parseForSaxon, runSchematron } from './lib/schematron.mjs';

const [xsdRoot, cenFile, peppolFile, invoiceFile] = process.argv.slice(2);
const now = () => process.hrtime.bigint();
const ms = (t) => Number(now() - t) / 1e6;
const mem = () => {
  const m = process.memoryUsage();
  return `rss=${(m.rss / 2 ** 20).toFixed(0)}MiB heapUsed=${(m.heapUsed / 2 ** 20).toFixed(0)}MiB`;
};

console.log(`baseline                      ${mem()}`);
let t = now();
const xsd = createUblXsdValidator(xsdRoot);
console.log(`XSD schema set compiled       ${ms(t).toFixed(0)} ms   ${mem()}`);
t = now();
const cen = loadSef(cenFile);
const peppol = loadSef(peppolFile);
console.log(`2 SEFs read+JSON.parse        ${ms(t).toFixed(0)} ms   ${mem()}`);

// build inputs: the example and a 200-line variant (duplicate InvoiceLine; totals wrong, irrelevant for timing)
const base = fs.readFileSync(invoiceFile, 'utf8');
const lineRe = /<cac:InvoiceLine>[\s\S]*?<\/cac:InvoiceLine>/;
const line = base.match(lineRe)[0];
const big = base.replace(lineRe, Array(200).fill(line).join('\n'));
const inputs = { 'base-example (2 lines, 9 KB)': base, [`200-line invoice (${(big.length / 1024).toFixed(0)} KB)`]: big };

let first = true;
for (const [name, xml] of Object.entries(inputs)) {
  const buf = Buffer.from(xml);
  if (first) {
    t = now(); const n0 = await parseForSaxon(xml); const p0 = ms(t);
    t = now(); runSchematron(cen, n0); const c0 = ms(t);
    t = now(); runSchematron(peppol, n0); const pp0 = ms(t);
    console.log(`first (cold) run: saxon parse ${p0.toFixed(0)} ms, CEN ${c0.toFixed(0)} ms, PEPPOL ${pp0.toFixed(0)} ms   ${mem()}`);
    first = false;
  }
  const N = name.startsWith('base') ? 100 : 20;
  const acc = { xsd: 0, parse: 0, cen: 0, peppol: 0 };
  let findings = 0;
  for (let i = 0; i < N; i++) {
    t = now(); xsd.validate(buf); acc.xsd += ms(t);
    t = now(); const node = await parseForSaxon(xml); acc.parse += ms(t);
    t = now(); findings = runSchematron(cen, node).length; acc.cen += ms(t);
    t = now(); findings += runSchematron(peppol, node).length; acc.peppol += ms(t);
  }
  const f = (v) => (v / N).toFixed(2).padStart(8);
  console.log(`\n${name}: warm avg over ${N} runs (findings=${findings})`);
  console.log(`  XSD (libxml2-wasm parse+validate) ${f(acc.xsd)} ms`);
  console.log(`  SaxonJS parse                     ${f(acc.parse)} ms`);
  console.log(`  CEN schematron + SVRL extract     ${f(acc.cen)} ms`);
  console.log(`  PEPPOL schematron + SVRL extract  ${f(acc.peppol)} ms`);
  console.log(`  ${mem()}`);
}
