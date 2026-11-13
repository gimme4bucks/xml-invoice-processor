import type { XmlNode } from 'libxml2-wasm';
import { DomainError } from '../../../domain/errors';
import type {
  CanonicalDocument,
  InvoiceLine,
  InvoiceParty,
  InvoiceTotals,
  PrecedingInvoice,
} from '../../../domain/invoice';
import { type DocumentType, PeppolParticipantId } from '../../../domain/value-objects';
import { InvoiceMapper } from '../../../application/ports';
import { type Libxml2, loadLibxml2, safeParseOptions } from './libxml2';
import { UBL_NAMESPACES } from './ubl';

const NS = {
  ubl: UBL_NAMESPACES.ubl,
  cn: UBL_NAMESPACES.cn,
  cac: UBL_NAMESPACES.cac,
  cbc: UBL_NAMESPACES.cbc,
};

/** Where UBL puts the EN 16931 fields that are named differently in a credit note (ADR 0015). */
const SYNTAX: Record<
  DocumentType,
  { namespace: string; typeCode: string; line: string; quantity: string }
> = {
  Invoice: {
    namespace: UBL_NAMESPACES.ubl,
    typeCode: 'cbc:InvoiceTypeCode',
    line: 'cac:InvoiceLine',
    quantity: 'cbc:InvoicedQuantity',
  },
  CreditNote: {
    namespace: UBL_NAMESPACES.cn,
    typeCode: 'cbc:CreditNoteTypeCode',
    line: 'cac:CreditNoteLine',
    quantity: 'cbc:CreditedQuantity',
  },
};

/**
 * Anti-corruption layer from Peppol BIS 3.0 UBL (Invoice or CreditNote) to our canonical model,
 * using libxml2 XPath. Amounts and quantities are copied as the decimal strings they are in the
 * XML.
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

  map(xml: Buffer): CanonicalDocument {
    const doc = this.libxml.XmlDocument.fromBuffer(xml, { option: safeParseOptions(this.libxml) });
    try {
      if (doc.dtd) throw new Error('A DOCTYPE declaration is not allowed'); // intake rejects these
      const root = doc.root;
      const documentType = (Object.keys(SYNTAX) as DocumentType[]).find(
        (type) => root.name === type && root.namespaceUri === SYNTAX[type].namespace,
      );
      // Intake only accepts these two roots, so this is a programming error, not a client one.
      if (!documentType) throw new Error(`Not a UBL Invoice or CreditNote: ${root.name}`);
      const syntax = SYNTAX[documentType];
      const number = text(root, 'cbc:ID') ?? '';
      return {
        ...(documentType === 'CreditNote'
          ? { documentType, creditNoteNumber: number }
          : { documentType, invoiceNumber: number }),
        typeCode: text(root, syntax.typeCode) ?? '',
        issueDate: text(root, 'cbc:IssueDate') ?? '',
        dueDate: text(root, 'cbc:DueDate'),
        currency: text(root, 'cbc:DocumentCurrencyCode') ?? '',
        precedingInvoices: root
          .find('cac:BillingReference/cac:InvoiceDocumentReference', NS)
          .map(precedingInvoice),
        supplier: party(root, 'cac:AccountingSupplierParty', 'supplier'),
        customer: party(root, 'cac:AccountingCustomerParty', 'customer'),
        lines: root.find(syntax.line, NS).map((node) => line(node, syntax.quantity)),
        totals: totals(root),
      };
    } finally {
      doc.dispose(); // WASM memory is not garbage-collected
    }
  }
}

function party(root: XmlNode, element: string, role: string): InvoiceParty {
  const node = root.get(`${element}/cac:Party`, NS);
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

/** BG-3: BT-25 (the preceding invoice's number) and BT-26 (its issue date). */
function precedingInvoice(node: XmlNode): PrecedingInvoice {
  return { invoiceNumber: text(node, 'cbc:ID') ?? '', issueDate: text(node, 'cbc:IssueDate') };
}

function line(node: XmlNode, quantity: string): InvoiceLine {
  return {
    id: text(node, 'cbc:ID') ?? '',
    description: text(node, 'cac:Item/cbc:Name') ?? text(node, 'cac:Item/cbc:Description'),
    quantity: text(node, quantity) ?? '',
    unitCode: text(node, `${quantity}/@unitCode`),
    netAmount: text(node, 'cbc:LineExtensionAmount') ?? '',
    vatCategory: text(node, 'cac:Item/cac:ClassifiedTaxCategory/cbc:ID'),
    vatPercent: text(node, 'cac:Item/cac:ClassifiedTaxCategory/cbc:Percent'),
  };
}

function totals(root: XmlNode): InvoiceTotals {
  const amount = (name: string) => text(root, `cac:LegalMonetaryTotal/cbc:${name}`) ?? '';
  return {
    lineExtensionAmount: amount('LineExtensionAmount'),
    taxExclusiveAmount: amount('TaxExclusiveAmount'),
    // A second TaxTotal may state the VAT in the accounting currency (BT-111); we want BT-110.
    taxAmount:
      text(root, 'cac:TaxTotal/cbc:TaxAmount[@currencyID = ../../cbc:DocumentCurrencyCode]') ??
      text(root, 'cac:TaxTotal/cbc:TaxAmount') ??
      '',
    taxInclusiveAmount: amount('TaxInclusiveAmount'),
    payableAmount: amount('PayableAmount'),
  };
}

/** Trimmed text of the first match, or undefined when absent or empty. */
function text(context: XmlNode, xpath: string): string | undefined {
  return context.get(xpath, NS)?.content.trim() || undefined;
}
