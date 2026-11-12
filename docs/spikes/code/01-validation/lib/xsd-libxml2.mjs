// XSD layer with libxml2-wasm: compile the UBL 2.1 schema set ONCE, validate many times.
import fs from 'node:fs';
import path from 'node:path';
import {
  XmlDocument,
  XsdValidator,
  XmlBufferInputProvider,
  xmlRegisterInputProvider,
  ParseOption,
  XmlValidateError,
  XmlParseError,
} from 'libxml2-wasm';

const UBL_NS = {
  Invoice: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
  CreditNote: 'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2',
};

// Hardened parse flags for untrusted input: no network, never load external
// entities/DTDs (NOENT/DTDLOAD are off by default anyway).
const SAFE_PARSE = ParseOption.XML_PARSE_NONET | ParseOption.XML_PARSE_NO_XXE;

/**
 * @param {string} xsdRoot directory containing common/ and maindoc/ (UBL 2.1 xsdrt or xsd)
 */
export function createUblXsdValidator(xsdRoot, mainDoc = 'maindoc/UBL-Invoice-2.1.xsd') {
  // Expose every schema file to libxml2 through an in-memory virtual path.
  // Relative xsd:import "../common/X.xsd" resolves against the url we give the main doc.
  const VROOT = '/ubl-2.1/';
  const buffers = {};
  for (const dir of ['common', 'maindoc']) {
    for (const f of fs.readdirSync(path.join(xsdRoot, dir))) {
      if (f.endsWith('.xsd')) buffers[`${VROOT}${dir}/${f}`] = fs.readFileSync(path.join(xsdRoot, dir, f));
    }
  }
  xmlRegisterInputProvider(new XmlBufferInputProvider(buffers));

  const schemaDoc = XmlDocument.fromBuffer(buffers[VROOT + mainDoc], { url: VROOT + mainDoc, option: SAFE_PARSE });
  const validator = XsdValidator.fromDoc(schemaDoc); // resolves all imports via the buffer provider
  schemaDoc.dispose();

  return {
    /**
     * @param {Uint8Array} xml
     * @returns {{ok: boolean, root?: {ns: string, name: string}, errors: {stage: string, message: string, line?: number, col?: number}[]}}
     */
    validate(xml) {
      let doc;
      try {
        doc = XmlDocument.fromBuffer(xml, { url: 'invoice.xml', option: SAFE_PARSE });
      } catch (e) {
        if (e instanceof XmlParseError) {
          return { ok: false, errors: e.details.map((d) => ({ stage: 'parse', message: d.message.trim(), line: d.line, col: d.col })) };
        }
        throw e;
      }
      try {
        if (doc.dtd) return { ok: false, errors: [{ stage: 'doctype', message: 'DOCTYPE not allowed' }] };
        const root = { ns: doc.root.namespaceUri, name: doc.root.name };
        if (!(root.name === 'Invoice' && root.ns === UBL_NS.Invoice)) {
          return { ok: false, root, errors: [{ stage: 'root', message: `Unsupported root element {${root.ns}}${root.name}` }] };
        }
        try {
          validator.validate(doc);
          return { ok: true, root, errors: [] };
        } catch (e) {
          if (e instanceof XmlValidateError) {
            return { ok: false, root, errors: e.details.map((d) => ({ stage: 'xsd', message: d.message.trim(), line: d.line, col: d.col })) };
          }
          throw e;
        }
      } finally {
        doc.dispose(); // wasm heap memory is NOT garbage collected - always dispose
      }
    },
    dispose() {
      validator.dispose();
    },
  };
}
