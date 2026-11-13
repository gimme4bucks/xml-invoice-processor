import { beforeAll, describe, expect, it } from 'vitest';
import { peppolFixture } from '../../../../../test/fixtures/peppol';
import { DomainError } from '../../../domain/errors';
import { determineDirection, PeppolParticipantId } from '../../../domain/value-objects';
import { UblInvoiceMapper } from './ubl-invoice-mapper';

const organisation = PeppolParticipantId.parse('0106:11111111');

describe('UblInvoiceMapper', () => {
  let mapper: UblInvoiceMapper;

  beforeAll(async () => {
    mapper = await UblInvoiceMapper.create();
  });

  it('maps a sales invoice to the canonical model, amounts as decimal strings', () => {
    const invoice = mapper.map(peppolFixture('valid-sales'));

    expect({
      ...invoice,
      supplier: { ...invoice.supplier, endpointId: invoice.supplier.endpointId.toString() },
      customer: { ...invoice.customer, endpointId: invoice.customer.endpointId.toString() },
    }).toEqual({
      documentType: 'Invoice',
      invoiceNumber: 'INV-2026-0101',
      issueDate: '2026-11-02',
      dueDate: '2026-12-02',
      currency: 'EUR',
      supplier: {
        name: 'Acme Supplies B.V.',
        endpointId: '0106:11111111',
        vatNumber: 'NL001234567B01',
      },
      customer: {
        name: 'Beta Retail B.V.',
        endpointId: '0106:22222222',
        vatNumber: 'NL009876543B01',
      },
      lines: [
        {
          id: '1',
          description: 'Consulting hours',
          quantity: '10',
          unitCode: 'HUR',
          netAmount: '1000.00',
          vatCategory: 'S',
          vatPercent: '21',
        },
        {
          id: '2',
          description: 'Training workbook',
          quantity: '3',
          unitCode: 'C62',
          netAmount: '300.00',
          vatCategory: 'S',
          vatPercent: '21',
        },
      ],
      totals: {
        lineExtensionAmount: '1300.00',
        taxExclusiveAmount: '1300.00',
        taxAmount: '273.00',
        taxInclusiveAmount: '1573.00',
        payableAmount: '1573.00',
      },
    });
    expect(
      determineDirection(organisation, invoice.supplier.endpointId, invoice.customer.endpointId),
    ).toBe('sales');
  });

  it('maps a purchase invoice with two VAT rates and a prepaid amount', () => {
    const invoice = mapper.map(peppolFixture('valid-purchase'));

    expect(invoice.supplier.endpointId.toString()).toBe('0106:33333333');
    expect(invoice.supplier.vatNumber).toBe('NL003333333B01');
    expect(invoice.customer.endpointId.toString()).toBe('0106:11111111');
    expect(
      determineDirection(organisation, invoice.supplier.endpointId, invoice.customer.endpointId),
    ).toBe('purchase');
    expect(
      invoice.lines.map((l) => [l.id, l.description, l.unitCode, l.netAmount, l.vatPercent]),
    ).toEqual([
      ['10', 'Office chair', 'C62', '500.00', '21'],
      ['20', 'Coffee beans', 'KGM', '125.00', '9'],
    ]);
    expect(invoice.totals).toEqual({
      lineExtensionAmount: '625.00',
      taxExclusiveAmount: '625.00',
      taxAmount: '116.25',
      taxInclusiveAmount: '741.25',
      payableAmount: '641.25',
    });
  });

  it('maps all 300 lines of a large invoice', () => {
    const invoice = mapper.map(peppolFixture('large-300-lines'));
    expect(invoice.lines).toHaveLength(300);
    expect(invoice.lines[299]).toMatchObject({ id: '300', netAmount: '10.00' });
  });

  it('takes the VAT total in the document currency, not the one in the accounting currency', () => {
    const xml = peppolFixture('valid-sales')
      .toString('utf8')
      .replace(
        '<cac:TaxTotal>',
        '<cac:TaxTotal><cbc:TaxAmount currencyID="SEK">3100.00</cbc:TaxAmount></cac:TaxTotal><cac:TaxTotal>',
      );
    expect(mapper.map(Buffer.from(xml)).totals.taxAmount).toBe('273.00');
  });

  it('leaves judging other missing fields to the business rules', () => {
    expect(mapper.map(peppolFixture('missing-issue-date')).issueDate).toBe('');
  });

  it('throws a DomainError when a party has no EndpointID', () => {
    const xml = peppolFixture('valid-sales')
      .toString('utf8')
      .replace('<cbc:EndpointID schemeID="0106">22222222</cbc:EndpointID>', '');
    expect(() => mapper.map(Buffer.from(xml))).toThrow(
      expect.objectContaining({ code: 'MISSING_ENDPOINT_ID' }) as DomainError,
    );
  });
});
