import { readFileSync } from 'node:fs';
import { workerData } from 'node:worker_threads';
import SaxonJS from 'saxon-js';

// Runs in a piscina worker thread: SaxonJS transforms synchronously and blocks for 40 ms up to
// seconds per invoice (ADR 0002), so they must stay off the event loop.
//
// No local imports on purpose: unit tests run this file from source with Node's type stripping,
// which cannot resolve extensionless TypeScript imports.

export interface SchematronWorkerData {
  /** Compiled stylesheets (SEF), run in this order on every invoice. */
  sefPaths: string[];
}

/** One `svrl:failed-assert` or `svrl:successful-report`, as SaxonJS reports it. */
export interface SvrlFinding {
  ruleId: string;
  flag: string;
  location: string;
  message: string;
}

const SVRL_NS = 'http://purl.oclc.org/dsdl/svrl';

// Turns the SVRL report into plain objects in one XPath. A failed-assert is an assert whose test
// was false; a successful-report is a report whose test was true. Both are findings.
const EXTRACT_FINDINGS = `array {
  //(svrl:failed-assert | svrl:successful-report) ! map {
    'ruleId': string(@id),
    'flag': string(@flag),
    'location': string(@location),
    'message': normalize-space(string-join(svrl:text, ' '))
  }
}`;

// Loaded once per thread (about 10 MB of JSON); SaxonJS reuses the same object for every run.
const { sefPaths } = workerData as SchematronWorkerData;
const stylesheets = sefPaths.map((file): unknown => JSON.parse(readFileSync(file, 'utf8')));

export default async function runSchematron(xml: string): Promise<SvrlFinding[]> {
  // Parsed once and reused for both rule sets.
  const sourceNode = await SaxonJS.getResource({ text: xml, type: 'xml' });
  return stylesheets.flatMap((stylesheetInternal) => {
    const report = SaxonJS.transform(
      { stylesheetInternal, sourceNode, destination: 'document' },
      'sync',
    );
    return SaxonJS.XPath.evaluate(EXTRACT_FINDINGS, report.principalResult, {
      namespaceContext: { svrl: SVRL_NS },
    }) as SvrlFinding[];
  });
}
