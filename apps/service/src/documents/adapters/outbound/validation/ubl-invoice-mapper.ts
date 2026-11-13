import type { XmlDocument, XmlNode } from 'libxml2-wasm';
import { DomainError } from '../../../domain/errors';
import type {
  CanonicalInvoice,
  InvoiceLine,
  InvoiceParty,
  InvoiceTotals,
} from '../../../domain/invoice';
import { PeppolParticipantId } from '../../../domain/value-objects';
import { InvoiceMapper } from '../../../application/ports';
import { type Libxml2, loadLibxml2, safeParseOptions } from './libxml2';
import { UBL_NAMESPACES } from './ubl';

const NS = { ubl: UBL_NAMESPACES.ubl, cac: UBL_NAMESPACES.cac, cbc: UBL_NAMESPACES.cbc };

/**
 * Anti-corruption layer from Peppol BIS 3.0 UBL to our CanonicalInvoice, using libxml2 XPath.
 * Amounts and quantities are copied as the decimal strings they are in the XML.
 *
 * It runs at intake (only the endpoint IDs matter there, to derive purchase or sales) and in the
 * worker after the Schematron rules passed. So only a missing or malformed EndpointID throws;
 * other fields that EN 16931 requires map to '' when absent, because judging those is the job of
 * the business rules, which report them with their official rule IDs (ADR 0002).
 */
export class UblInvoiceMapper extends InvoiceMapper {
  private constructor(private readonly libxml: Libxml2) {
    super();
  }

  static async create(): Promise<UblInvoiceMapper> {
    return new UblInvoiceMapper(await loadLibxml2());
  }

  map(xml: Buffer): CanonicalInvoice {
    const doc = this.libxml.XmlDocument.fromBuffer(xml, { option: safeParseOptions(this.libxml) });
    try {
      if (doc.dtd) throw new Error('A DOCTYPE declaration is not allowed'); // intake rejects these
      const invoice = doc.root;
      return {
        documentType: 'Invoice',
        invoiceNumber: text(invoice, 'cbc:ID') ?? '',
        issueDate: text(invoice, 'cbc:IssueDate') ?? '',
        dueDate: text(invoice, 'cbc:DueDate'),
        currency: text(invoice, 'cbc:DocumentCurrencyCode') ?? '',
        supplier: party(doc, 'cac:AccountingSupplierParty', 'supplier'),
        customer: party(doc, 'cac:AccountingCustomerParty', 'customer'),
        lines: invoice.find('cac:InvoiceLine', NS).map(line),
        totals: totals(invoice),
      };
    } finally {
      doc.dispose(); // WASM memory is not garbage-collected
    }
  }
}

function party(doc: XmlDocument, element: string, role: string): InvoiceParty {
  const node = doc.get(`/ubl:Invoice/${element}/cac:Party`, NS);
  const endpoint = node?.get('cbc:EndpointID', NS);
  const value = endpoint?.content.trim();
  const scheme = endpoint?.get('@schemeID')?.content.trim();
  if (!node || !value || !scheme) {
    throw new DomainError(
      'MISSING_ENDPOINT_ID',
      `The ${role} has no cbc:EndpointID with a schemeID (Peppol participant id)`,
    );
  }
  return {
    // BT-27 (legal name), falling back to BT-28 (trading name).
    name:
      text(node, 'cac:PartyLegalEntity/cbc:RegistrationName') ??
      text(node, 'cac:PartyName/cbc:Name'),
    endpointId: PeppolParticipantId.parse(`${scheme}:${value}`),
    vatNumber: text(node, "cac:PartyTaxScheme[cac:TaxScheme/cbc:ID = 'VAT']/cbc:CompanyID"),
  };
}

function line(node: XmlNode): InvoiceLine {
  return {
    id: text(node, 'cbc:ID') ?? '',
    description: text(node, 'cac:Item/cbc:Name') ?? text(node, 'cac:Item/cbc:Description'),
    quantity: text(node, 'cbc:InvoicedQuantity') ?? '',
    unitCode: text(node, 'cbc:InvoicedQuantity/@unitCode'),
    netAmount: text(node, 'cbc:LineExtensionAmount') ?? '',
    vatCategory: text(node, 'cac:Item/cac:ClassifiedTaxCategory/cbc:ID'),
    vatPercent: text(node, 'cac:Item/cac:ClassifiedTaxCategory/cbc:Percent'),
  };
}

function totals(invoice: XmlNode): InvoiceTotals {
  const amount = (name: string) => text(invoice, `cac:LegalMonetaryTotal/cbc:${name}`) ?? '';
  return {
    lineExtensionAmount: amount('LineExtensionAmount'),
    taxExclusiveAmount: amount('TaxExclusiveAmount'),
    // A second TaxTotal may state the VAT in the accounting currency (BT-111); we want BT-110.
    taxAmount:
      text(
        invoice,
        'cac:TaxTotal/cbc:TaxAmount[@currencyID = /ubl:Invoice/cbc:DocumentCurrencyCode]',
      ) ??
      text(invoice, 'cac:TaxTotal/cbc:TaxAmount') ??
      '',
    taxInclusiveAmount: amount('TaxInclusiveAmount'),
    payableAmount: amount('PayableAmount'),
  };
}

/** Trimmed text of the first match, or undefined when absent or empty. */
function text(context: XmlNode, xpath: string): string | undefined {
  return context.get(xpath, NS)?.content.trim() || undefined;
}
