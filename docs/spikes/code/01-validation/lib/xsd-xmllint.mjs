// XSD layer with xmllint-wasm: each call spawns a worker running the xmllint CLI and re-parses the schema set.
import fs from 'node:fs';
import path from 'node:path';
import { validateXML } from 'xmllint-wasm';

export function createUblXsdValidatorXmllint(xsdRoot, mainDoc = 'maindoc/UBL-Invoice-2.1.xsd') {
  const preload = [];
  for (const dir of ['common', 'maindoc']) {
    for (const f of fs.readdirSync(path.join(xsdRoot, dir))) {
      if (f.endsWith('.xsd') && `${dir}/${f}` !== mainDoc) {
        // fileName may contain directories: xmllint-wasm creates them in its in-memory FS
        preload.push({ fileName: `${dir}/${f}`, contents: fs.readFileSync(path.join(xsdRoot, dir, f)) });
      }
    }
  }
  const schema = { fileName: mainDoc, contents: fs.readFileSync(path.join(xsdRoot, mainDoc)) };
  return {
    async validate(xml) {
      const res = await validateXML({
        xml: { fileName: 'invoice.xml', contents: xml },
        schema,
        preload,
        // add --nonet; xmllint CLI does not substitute entities or load DTDs unless asked (--noent/--loaddtd)
        modifyArguments: (args) => ['--nonet', ...args],
        maxMemoryPages: 4096, // 256 MiB cap; default 32 MiB is enough for small invoices
      });
      return {
        ok: res.valid,
        errors: res.errors.map((e) => ({ stage: 'xsd', message: e.message, line: e.loc?.lineNumber })),
        raw: res.rawOutput,
      };
    },
  };
}
