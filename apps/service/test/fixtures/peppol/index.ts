import fs from 'node:fs';
import path from 'node:path';

/**
 * Peppol BIS Billing 3.0 fixtures, all written for this project (OpenPeppol's examples have no
 * licence). Organisation 0106:11111111 is the supplier on valid-sales and the customer on
 * valid-purchase.
 */
export type PeppolFixture =
  | 'valid-sales'
  | 'valid-purchase'
  | 'bad-totals'
  | 'missing-issue-date'
  | 'doctype-xxe'
  | 'credit-note'
  | 'large-300-lines';

export function peppolFixture(name: PeppolFixture): Buffer {
  return fs.readFileSync(path.join(__dirname, `${name}.xml`));
}

/**
 * Whether `build:validation` has produced the Schematron SEFs. CI's verify job does not run it
 * yet, so specs that need them are skipped there instead of failing.
 */
export function schematronArtifactsBuilt(): boolean {
  const generated = path.resolve(__dirname, '../../../validation-artifacts/generated');
  return ['cen-en16931-ubl.sef.json', 'peppol-en16931-ubl.sef.json'].every((file) =>
    fs.existsSync(path.join(generated, file)),
  );
}
