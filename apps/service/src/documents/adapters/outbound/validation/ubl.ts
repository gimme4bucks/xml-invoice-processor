import path from 'node:path';

/** UBL 2.1 namespaces with the prefixes the official rules use in their locations. */
export const UBL_NAMESPACES = {
  ubl: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
  cn: 'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2',
  cac: 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
  cbc: 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
  ext: 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2',
} as const;

/**
 * `apps/service/validation-artifacts`: the committed UBL XSDs and CEN XSLT plus the SEFs that
 * `build:validation` writes to `generated/`. This file sits five levels below `apps/service`
 * both in `src/` and in `dist/`; `VALIDATION_ARTIFACTS_DIR` overrides it (e.g. in a container).
 */
export function validationArtifactsDir(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.VALIDATION_ARTIFACTS_DIR ?? path.resolve(__dirname, '../../../../../validation-artifacts')
  );
}
