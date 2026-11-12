// usage: node xsd-test.mjs <xsdRoot> <xml files...>
import fs from 'node:fs';
import path from 'node:path';
import { createUblXsdValidator } from './lib/xsd-libxml2.mjs';
import { createUblXsdValidatorXmllint } from './lib/xsd-xmllint.mjs';

const [xsdRoot, ...files] = process.argv.slice(2);
const ms = (t) => Number(process.hrtime.bigint() - t) / 1e6;

let t = process.hrtime.bigint();
const lx = createUblXsdValidator(xsdRoot);
console.log(`libxml2-wasm: schema compile ${ms(t).toFixed(1)} ms, rss=${(process.memoryUsage().rss / 2 ** 20).toFixed(0)} MiB`);
const xl = createUblXsdValidatorXmllint(xsdRoot);

for (const f of files) {
  const buf = fs.readFileSync(f);
  t = process.hrtime.bigint();
  const r1 = lx.validate(buf);
  const t1 = ms(t);
  t = process.hrtime.bigint();
  const r2 = await xl.validate(buf);
  const t2 = ms(t);
  console.log(`\n== ${path.basename(f)}`);
  console.log(`  libxml2-wasm (${t1.toFixed(1)} ms):`, JSON.stringify(r1));
  console.log(`  xmllint-wasm (${t2.toFixed(1)} ms):`, JSON.stringify({ ok: r2.ok, errors: r2.errors }));
}

// warm timing
const base = fs.readFileSync(files[0]);
const N = 200;
t = process.hrtime.bigint();
for (let i = 0; i < N; i++) lx.validate(base);
console.log(`\nlibxml2-wasm warm: ${(ms(t) / N).toFixed(2)} ms/invoice over ${N} runs`);
const M = 20;
t = process.hrtime.bigint();
for (let i = 0; i < M; i++) await xl.validate(base);
console.log(`xmllint-wasm warm: ${(ms(t) / M).toFixed(2)} ms/invoice over ${M} runs`);
console.log(`rss=${(process.memoryUsage().rss / 2 ** 20).toFixed(0)} MiB`);
