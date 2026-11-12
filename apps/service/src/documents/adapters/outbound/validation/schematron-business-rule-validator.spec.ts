import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { peppolFixture, schematronArtifactsBuilt } from '../../../../../test/fixtures/peppol';
import {
  SchematronBusinessRuleValidator,
  TIMEOUT_RULE_ID,
} from './schematron-business-rule-validator';

const built = schematronArtifactsBuilt();
if (!built) console.warn('Schematron specs skipped: run pnpm -F @xip/service build:validation');

// Runs the real official rule sets; the first invoice per thread includes loading the SEFs.
describe.skipIf(!built)('SchematronBusinessRuleValidator', { timeout: 60_000 }, () => {
  let validator: SchematronBusinessRuleValidator;

  beforeAll(() => {
    validator = new SchematronBusinessRuleValidator({ poolSize: 2 });
  });

  afterAll(() => validator.onModuleDestroy());

  it.each(['valid-sales', 'valid-purchase'] as const)(
    'finds no violations in %s',
    async (fixture) => {
      expect(await validator.validate(peppolFixture(fixture))).toEqual([]);
    },
  );

  it('reports wrong totals as fatal BR-CO-10, BR-CO-13 and BR-CO-16', async () => {
    const violations = await validator.validate(peppolFixture('bad-totals'));

    expect(violations.map((v) => [v.ruleId, v.flag, v.location])).toEqual([
      ['BR-CO-10', 'fatal', '/ubl:Invoice[1]/cac:LegalMonetaryTotal[1]'],
      ['BR-CO-13', 'fatal', '/ubl:Invoice[1]/cac:LegalMonetaryTotal[1]'],
      ['BR-CO-16', 'fatal', '/ubl:Invoice[1]/cac:LegalMonetaryTotal[1]'],
    ]);
    expect(violations[0]?.message).toMatch(/^\[BR-CO-10\]-Sum of Invoice line net amount/);
  });

  it('also reports a missing issue date (BR-03)', async () => {
    const violations = await validator.validate(peppolFixture('missing-issue-date'));
    expect(violations).toEqual([
      expect.objectContaining({ ruleId: 'BR-03', flag: 'fatal', location: '/ubl:Invoice[1]' }),
    ]);
  });

  it('validates a 300-line invoice', async () => {
    const started = performance.now();
    expect(await validator.validate(peppolFixture('large-300-lines'))).toEqual([]);
    console.info(`300-line invoice: ${Math.round(performance.now() - started)} ms`);
  });

  it('runs more invoices than threads without mixing up results', async () => {
    const results = await Promise.all(
      (['bad-totals', 'valid-sales', 'bad-totals', 'valid-purchase', 'bad-totals'] as const).map(
        (fixture) => validator.validate(peppolFixture(fixture)),
      ),
    );
    expect(results.map((violations) => violations.length)).toEqual([3, 0, 3, 0, 3]);
  });

  it('turns a run that exceeds the timeout into a fatal violation', async () => {
    const impatient = new SchematronBusinessRuleValidator({ poolSize: 1, timeoutMs: 50 });
    try {
      expect(await impatient.validate(peppolFixture('large-300-lines'))).toEqual([
        {
          ruleId: TIMEOUT_RULE_ID,
          flag: 'fatal',
          message: 'Business rule validation did not finish within 50 ms',
          location: '/ubl:Invoice[1]',
        },
      ]);
    } finally {
      await impatient.onModuleDestroy();
    }
  });
});

describe('SchematronBusinessRuleValidator without artifacts', () => {
  it('fails at construction and says how to build them', () => {
    expect(() => new SchematronBusinessRuleValidator({ artifactsDir: '/nonexistent' })).toThrow(
      /build:validation/,
    );
  });
});
