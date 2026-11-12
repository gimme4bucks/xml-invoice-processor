import { describe, expect, it } from 'vitest';
import { normaliseLocation, toRuleViolations } from './svrl';

const INVOICE = 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2';
const CAC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2';
const CBC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2';

describe('normaliseLocation', () => {
  it('shortens CEN (ISO skeleton) locations', () => {
    expect(
      normaliseLocation(
        `/*:Invoice[namespace-uri()='${INVOICE}'][1]/*:LegalMonetaryTotal[namespace-uri()='${CAC}'][1]`,
      ),
    ).toBe('/ubl:Invoice[1]/cac:LegalMonetaryTotal[1]');
  });

  it('shortens Peppol (SchXslt2 fn:path) locations, attributes included', () => {
    expect(
      normaliseLocation(
        `/Q{${INVOICE}}Invoice[1]/Q{${CAC}}AccountingSupplierParty[1]/Q{${CAC}}Party[1]/Q{${CBC}}EndpointID[1]/@schemeID`,
      ),
    ).toBe(
      '/ubl:Invoice[1]/cac:AccountingSupplierParty[1]/cac:Party[1]/cbc:EndpointID[1]/@schemeID',
    );
  });

  it('keeps unknown namespaces readable', () => {
    expect(normaliseLocation('/Q{urn:example}Thing[1]/Q{}Local[1]')).toBe(
      '/Q{urn:example}Thing[1]/Local[1]',
    );
  });
});

describe('toRuleViolations', () => {
  const finding = (ruleId: string, flag: string) => ({
    ruleId,
    flag,
    message: `[${ruleId}]-message`,
    location: `/Q{${INVOICE}}Invoice[1]`,
  });

  it('drops the false DE-R-019/DE-R-020 findings of the SaxonJS big-integer mod bug', () => {
    const violations = toRuleViolations([
      finding('DE-R-019', 'warning'),
      finding('BR-CO-10', 'fatal'),
      finding('DE-R-020', 'warning'),
      finding('DE-R-018', 'fatal'),
    ]);
    expect(violations.map((v) => v.ruleId)).toEqual(['BR-CO-10', 'DE-R-018']);
  });

  it('keeps the official id and message and normalises the location', () => {
    expect(toRuleViolations([finding('BR-CO-10', 'fatal')])).toEqual([
      {
        ruleId: 'BR-CO-10',
        flag: 'fatal',
        message: '[BR-CO-10]-message',
        location: '/ubl:Invoice[1]',
      },
    ]);
  });

  it('treats every flag other than fatal as a warning', () => {
    const flags = toRuleViolations([
      finding('A', 'warning'),
      finding('B', 'information'),
      finding('C', ''),
    ]).map((v) => v.flag);
    expect(flags).toEqual(['warning', 'warning', 'warning']);
  });
});
