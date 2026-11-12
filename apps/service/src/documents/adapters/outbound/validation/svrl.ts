import type { RuleViolation } from '../../../domain/document-events';
import type { SvrlFinding } from './schematron.worker';
import { UBL_NAMESPACES } from './ubl';

/**
 * Rules dropped from every report. DE-R-019 and DE-R-020 check German IBANs with `mod 97` on an
 * integer above 2^53, which SaxonJS 2.7 computes in doubles: `512108001245126199131475 mod 97`
 * gives 83 instead of 1, so valid IBANs are flagged (spike 01, the one failing official Peppol
 * unit test). Both are warnings and only apply to German-to-German invoices. Re-checking them in
 * TypeScript is an ADR 0001 follow-up.
 */
export const IGNORED_RULES: ReadonlySet<string> = new Set(['DE-R-019', 'DE-R-020']);

const PREFIX_BY_NAMESPACE = new Map<string, string>(
  Object.entries(UBL_NAMESPACES).map(([prefix, namespace]) => [namespace, prefix]),
);

/** Maps raw SVRL findings to our RuleViolation: known false positives dropped, paths shortened. */
export function toRuleViolations(findings: SvrlFinding[]): RuleViolation[] {
  return findings
    .filter((finding) => !IGNORED_RULES.has(finding.ruleId))
    .map((finding) => ({
      ruleId: finding.ruleId,
      // Only `fatal` rejects a document; anything else (`warning`, a missing flag) is reported.
      flag: finding.flag === 'fatal' ? 'fatal' : 'warning',
      message: finding.message,
      location: normaliseLocation(finding.location),
    }));
}

/**
 * The two rule sets write locations differently; both become `/ubl:Invoice[1]/cac:…[1]`:
 * - CEN (ISO skeleton): `/*:Invoice[namespace-uri()='urn:…:Invoice-2'][1]/*:LegalMonetaryTotal[namespace-uri()='…'][1]`
 * - Peppol (SchXslt2, `fn:path()`): `/Q{urn:…:Invoice-2}Invoice[1]/Q{urn:…}LegalMonetaryTotal[1]`
 */
export function normaliseLocation(location: string): string {
  return location
    .replace(/\*:([\w.-]+)\[namespace-uri\(\)='([^']*)'\]/g, (_, name: string, namespace: string) =>
      qualify(namespace, name),
    )
    .replace(/Q\{([^}]*)\}([\w.-]+)/g, (_, namespace: string, name: string) =>
      qualify(namespace, name),
    );
}

function qualify(namespace: string, name: string): string {
  if (!namespace) return name;
  const prefix = PREFIX_BY_NAMESPACE.get(namespace);
  return prefix ? `${prefix}:${name}` : `Q{${namespace}}${name}`;
}
