import type { PeppolParticipantId } from './value-objects';

/**
 * Canonical invoice: our own model, independent of the wire format. The UBL/Peppol mapper
 * (an outbound adapter) translates into it; other formats would get their own mapper.
 * Amounts are decimal strings to avoid floating-point rounding.
 */
export interface CanonicalInvoice {
  invoiceNumber: string;
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
