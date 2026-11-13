import { DomainError } from './errors';

/** Purchase or sales invoice, seen from the organisation that submitted it. */
export type InvoiceDirection = 'purchase' | 'sales';

/** The UBL 2.1 document: an invoice or a credit note (Peppol BIS Billing 3.0). */
export type DocumentType = 'Invoice' | 'CreditNote';

export type DocumentStatus = 'Received' | 'Processing' | 'Completed' | 'Failed';

/** The organisation (tenant) a document belongs to. Always taken from the access token. */
export class OrganisationId {
  private constructor(readonly value: string) {}

  static parse(raw: string): OrganisationId {
    if (raw.trim() === '') {
      throw new DomainError('INVALID_ORGANISATION_ID', 'The organisation id must not be empty');
    }
    return new OrganisationId(raw);
  }

  toString(): string {
    return this.value;
  }
}

/**
 * The client's `Idempotency-Key` (ADR 0007): 1–255 printable ASCII characters, space included.
 * Scoped per organisation.
 */
export class IdempotencyKey {
  private constructor(readonly value: string) {}

  static parse(raw: string): IdempotencyKey {
    if (!/^[\x20-\x7e]{1,255}$/.test(raw)) {
      // The raw value is not echoed: it is untrusted input of any length.
      throw new DomainError(
        'INVALID_IDEMPOTENCY_KEY',
        'The Idempotency-Key must be 1 to 255 printable ASCII characters',
      );
    }
    return new IdempotencyKey(raw);
  }

  toString(): string {
    return this.value;
  }
}

/** SHA-256 of the submitted bytes as 64 lowercase hex characters (Node's `digest('hex')`). */
export class ContentHash {
  private constructor(readonly value: string) {}

  static parse(raw: string): ContentHash {
    if (!/^[0-9a-f]{64}$/.test(raw)) {
      throw new DomainError(
        'INVALID_CONTENT_HASH',
        'A content hash must be a SHA-256 digest as 64 lowercase hex characters',
      );
    }
    return new ContentHash(raw);
  }

  toString(): string {
    return this.value;
  }
}

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
