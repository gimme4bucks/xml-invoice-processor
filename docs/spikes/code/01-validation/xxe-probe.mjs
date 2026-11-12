// Probe: does libxml2-wasm load an external entity that points at a registered in-memory buffer?
import { XmlDocument, ParseOption, XmlBufferInputProvider, xmlRegisterInputProvider } from 'libxml2-wasm';
xmlRegisterInputProvider(new XmlBufferInputProvider({ '/secret.txt': new TextEncoder().encode('SECRET-CONTENT') }));
const xml = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "/secret.txt"><!ENTITY i "INTERNAL">]><r><a>&x;</a><b>&i;</b></r>`;
for (const [name, opt] of Object.entries({
  default: ParseOption.XML_PARSE_DEFAULT,
  'NONET|NO_XXE': ParseOption.XML_PARSE_NONET | ParseOption.XML_PARSE_NO_XXE,
  'NOENT (dangerous)': ParseOption.XML_PARSE_NOENT,
})) {
  try {
    const d = XmlDocument.fromString(xml, { option: opt });
    console.log(name.padEnd(20), '=>', d.root.toString(), '| dtd present:', !!d.dtd);
    d.dispose();
  } catch (e) { console.log(name.padEnd(20), '=> ERR', e.message); }
}
