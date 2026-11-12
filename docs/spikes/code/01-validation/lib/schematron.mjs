// Schematron layer: run precompiled SEF (from xslt3 -export) with SaxonJS and extract SVRL failures.
import fs from 'node:fs';
import SaxonJS from 'saxon-js';

const SVRL_NS = 'http://purl.oclc.org/dsdl/svrl';

/** Load a SEF once at startup. Reuse the same object for every transform. */
export function loadSef(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Parse the invoice once (SaxonJS's own JS parser) and reuse the node for every stylesheet. */
export async function parseForSaxon(xmlText) {
  return SaxonJS.getResource({ text: xmlText, type: 'xml' });
}

// One XPath over the SVRL tree that returns plain JS objects.
// failed-assert = assert whose test was false; successful-report = report whose test was true.
const EXTRACT = `array {
  //(svrl:failed-assert | svrl:successful-report) ! map {
    'kind'    : local-name(),
    'ruleId'  : string(@id),
    'flag'    : string(@flag),
    'location': string(@location),
    'test'    : string(@test),
    'message' : normalize-space(string-join(svrl:text, ' '))
  }
}`;

/**
 * @returns {{ruleId:string, flag:string, message:string, location:string, test:string, kind:string}[]}
 */
export function runSchematron(sef, sourceNode) {
  const out = SaxonJS.transform(
    { stylesheetInternal: sef, sourceNode, destination: 'document' },
    'sync',
  );
  const items = SaxonJS.XPath.evaluate(EXTRACT, out.principalResult, {
    namespaceContext: { svrl: SVRL_NS },
  });
  return items.map((m) => ({ ...m, location: shortenLocation(m.location) }));
}

// Normalise the two location styles to prefix:local paths.
//   ISO skeleton (CEN xslt): /*:Invoice[namespace-uri()='urn:...:Invoice-2'][1]/*:LegalMonetaryTotal[namespace-uri()='...'][1]
//   SchXslt2 (fn:path()):    /Q{urn:...:Invoice-2}Invoice[1]/Q{urn:...CommonAggregateComponents-2}LegalMonetaryTotal[1]
const PREFIX = {
  'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2': 'ubl',
  'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2': 'cn',
  'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2': 'cac',
  'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2': 'cbc',
  'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2': 'ext',
};
export function shortenLocation(loc) {
  return loc
    .replace(/\*:([\w.-]+)\[namespace-uri\(\)='([^']*)'\]/g, (_, n, ns) => `${PREFIX[ns] ?? ns}:${n}`)
    .replace(/Q\{([^}]*)\}([\w.-]+)/g, (_, ns, n) => (ns ? `${PREFIX[ns] ?? ns}:${n}` : n));
}
