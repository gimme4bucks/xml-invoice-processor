// usage: node scale.mjs <cen.sef> <peppol.sef> <invoice.xml> <lineCounts...>  - one warm run per size
import fs from 'node:fs';
import { loadSef, parseForSaxon, runSchematron } from './lib/schematron.mjs';
const [cenF, pepF, inv, ...counts] = process.argv.slice(2);
const cen = loadSef(cenF), pep = loadSef(pepF);
const base = fs.readFileSync(inv, 'utf8');
const re = /<cac:InvoiceLine>[\s\S]*?<\/cac:InvoiceLine>/; const line = base.match(re)[0];
runSchematron(cen, await parseForSaxon(base)); runSchematron(pep, await parseForSaxon(base)); // warm up
for (const n of counts.map(Number)) {
  const node = await parseForSaxon(base.replace(re, Array(n).fill(line).join('\n')));
  let t = performance.now(); runSchematron(cen, node); const c = performance.now() - t;
  t = performance.now(); runSchematron(pep, node); const p = performance.now() - t;
  console.log(`${String(n).padStart(5)} lines: CEN ${c.toFixed(0).padStart(6)} ms  PEPPOL ${p.toFixed(0).padStart(6)} ms  rss=${(process.memoryUsage().rss/2**20).toFixed(0)}MiB`);
}
