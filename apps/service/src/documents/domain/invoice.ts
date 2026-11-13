import type { PeppolParticipantId } from './value-objects';

/**
 * Canonical invoice or credit note: our own model, independent of the wire format. The
 * UBL/Peppol mapper (an outbound adapter) translates into it; other formats would get their own
 * mapper. Amounts are decimal strings to avoid floating-point rounding.
 *
 * EN 16931 has one semantic model for both: a credit note is an invoice whose type code (BT-3)
 * credits, with positive amounts. UBL gives it its own root and line elements. Only the name of
 * the number differs here, so a client never takes a credit note number for an invoice number.
 */
export type CanonicalDocument = CanonicalInvoice | CanonicalCreditNote;

export interface CanonicalInvoice extends CanonicalDocumentFields {
  documentType: 'Invoice';
  /** BT-1. */
  invoiceNumber: string;
}

export interface CanonicalCreditNote extends CanonicalDocumentFields {
  documentType: 'CreditNote';
  /** BT-1 of a credit note. */
  creditNoteNumber: string;
}

interface CanonicalDocumentFields {
  issueDate: string;
  dueDate?: string;
  currency: string;
  supplier: InvoiceParty;
  customer: InvoiceParty;
  lines: InvoiceLine[];
  totals: InvoiceTotals;
}

export interface InvoiceParty {
  name?: string;
  endpointId: PeppolParticipantId;
  vatNumber?: string;
}

export interface InvoiceLine {
  id: string;
  description?: string;
  /** BT-129: the invoiced quantity, or on a credit note the credited quantity. */
  quantity: string;
  unitCode?: string;
  netAmount: string;
  vatCategory?: string;
  vatPercent?: string;
}

export interface InvoiceTotals {
  lineExtensionAmount: string;
  taxExclusiveAmount: string;
  taxAmount: string;
  taxInclusiveAmount: string;
  payableAmount: string;
}
