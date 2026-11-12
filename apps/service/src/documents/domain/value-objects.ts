import { DomainError } from './errors';

/** Purchase or sales invoice, seen from the organisation that submitted it. */
export type InvoiceDirection = 'purchase' | 'sales';

export type DocumentType = 'Invoice';

export type DocumentStatus = 'Received' | 'Processing' | 'Completed' | 'Failed';

/**
 * Peppol participant identifier, e.g. `0106:12345678` (scheme 0106 = Dutch KvK number).
 * Stored as `scheme:value`, compared case-insensitively as Peppol prescribes.
 */
export class PeppolParticipantId {
  private constructor(
    readonly scheme: string,
    readonly value: string,
  ) {}

  static parse(raw: string): PeppolParticipantId {
    const match = /^(\d{4}):(.+)$/.exec(raw.trim());
    if (!match?.[1] || !match[2]) {
      throw new DomainError('INVALID_PEPPOL_ID', `"${raw}" is not a Peppol participant id`);
    }
    return new PeppolParticipantId(match[1], match[2]);
  }

  equals(other: PeppolParticipantId): boolean {
    return this.scheme === other.scheme && this.value.toLowerCase() === other.value.toLowerCase();
  }

  toString(): string {
    return `${this.scheme}:${this.value}`;
  }
}

/**
 * The submitting organisation decides the direction: it is the supplier on its sales
 * invoices and the customer on its purchase invoices. Anything else is not its document.
 */
export function determineDirection(
  organisation: PeppolParticipantId,
  supplier: PeppolParticipantId,
  customer: PeppolParticipantId,
): InvoiceDirection | undefined {
  if (organisation.equals(supplier)) return 'sales';
  if (organisation.equals(customer)) return 'purchase';
  return undefined;
}
