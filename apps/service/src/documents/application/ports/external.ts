/** Transient: the VAT service could not answer (VIES is known to be unreliable). Retry later. */
export class VatServiceUnavailableError extends Error {
  constructor(reason: string) {
    super(`VAT verification unavailable: ${reason}`);
    this.name = 'VatServiceUnavailableError';
  }
}

/**
 * Verifies a counterparty VAT number (in production: EU VIES). `invalid` is a permanent outcome;
 * unavailability is signalled by throwing VatServiceUnavailableError.
 */
export abstract class VatNumberVerifier {
  abstract verify(vatNumber: string): Promise<'valid' | 'invalid'>;
}

export abstract class Clock {
  abstract now(): Date;
}

export abstract class IdGenerator {
  /** A new UUID. */
  abstract newId(): string;
}
