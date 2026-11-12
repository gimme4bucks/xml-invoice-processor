import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { peppolFixture } from '../../../../../test/fixtures/peppol';
import { LibxmlStructureValidator } from './libxml-structure-validator';

describe('LibxmlStructureValidator', () => {
  let validator: LibxmlStructureValidator;

  beforeAll(async () => {
    validator = await LibxmlStructureValidator.create();
  });

  afterAll(() => validator.onModuleDestroy());

  it.each(['valid-sales', 'valid-purchase', 'large-300-lines'] as const)(
    'accepts %s as a UBL 2.1 Invoice',
    (fixture) => {
      expect(validator.validate(peppolFixture(fixture))).toEqual({
        valid: true,
        documentType: 'Invoice',
      });
    },
  );

  it('accepts bad totals: those are business rules, checked later in the worker (ADR 0002)', () => {
    expect(validator.validate(peppolFixture('bad-totals')).valid).toBe(true);
  });

  it('rejects a missing IssueDate with the XSD error, line and column', () => {
    const xml = peppolFixture('missing-issue-date');
    const dueDateLine =
      xml
        .toString('utf8')
        .split('\n')
        .findIndex((l) => l.includes('DueDate')) + 1;

    const result = validator.validate(xml);

    expect(result).toMatchObject({ valid: false, reason: 'schema-invalid' });
    if (result.valid) return;
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ line: dueDateLine, column: expect.any(Number) });
    expect(result.errors[0]?.message).toMatch(/DueDate': This element is not expected/);
    expect(result.errors[0]?.message).toContain('IssueDate');
  });

  it('rejects a DOCTYPE with an external entity without resolving it (XXE)', () => {
    const result = validator.validate(peppolFixture('doctype-xxe'));

    expect(result).toMatchObject({ valid: false, reason: 'doctype-forbidden' });
    expect(JSON.stringify(result)).not.toContain('root:'); // no line of /etc/passwd
  });

  it('rejects any DOCTYPE, also one that only points at an external DTD', () => {
    const xml = Buffer.from(
      '<?xml version="1.0"?><!DOCTYPE Invoice SYSTEM "http://127.0.0.1:9/invoice.dtd">' +
        '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"/>',
    );
    expect(validator.validate(xml)).toMatchObject({ valid: false, reason: 'doctype-forbidden' });
  });

  it('rejects a UBL CreditNote as not supported yet', () => {
    expect(validator.validate(peppolFixture('credit-note'))).toMatchObject({
      valid: false,
      reason: 'unsupported-document-type',
    });
  });

  it.each([
    [
      'another UBL document',
      '<Order xmlns="urn:oasis:names:specification:ubl:schema:xsd:Order-2"/>',
    ],
    ['an Invoice without the UBL namespace', '<Invoice/>'],
  ])('rejects %s as schema-invalid', (_, xml) => {
    const result = validator.validate(Buffer.from(xml));
    expect(result).toMatchObject({ valid: false, reason: 'schema-invalid' });
    if (!result.valid) expect(result.errors[0]?.message).toMatch(/root element must be/);
  });

  it('rejects XML that is not well-formed, with the position of the error', () => {
    const result = validator.validate(Buffer.from('<Invoice>\n  <cbc:ID>1</Invoice>'));
    expect(result).toMatchObject({ valid: false, reason: 'not-well-formed' });
    if (!result.valid) expect(result.errors[0]).toMatchObject({ line: expect.any(Number) });
  });

  it('reports at most 50 errors plus a count of the rest', () => {
    // 300 lines, each with a price that is not a decimal: one XSD error per line.
    const xml = peppolFixture('large-300-lines')
      .toString('utf8')
      .replaceAll('>10.00</cbc:PriceAmount>', '>ten</cbc:PriceAmount>');

    const result = validator.validate(Buffer.from(xml));

    expect(result).toMatchObject({ valid: false, reason: 'schema-invalid' });
    if (result.valid) return;
    expect(result.errors).toHaveLength(51);
    expect(result.errors[50]?.message).toBe('250 more error(s) omitted');
  });
});
