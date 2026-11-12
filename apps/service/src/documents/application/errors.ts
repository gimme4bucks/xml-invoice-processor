import type { StructureError, StructureValidation } from './ports';

type InvalidStructure = Extract<StructureValidation, { valid: false }>;

/** The document failed the synchronous structural checks and was not accepted. */
export class DocumentRejectedError extends Error {
  readonly reason: InvalidStructure['reason'];
  readonly errors: StructureError[];

  constructor(result: InvalidStructure) {
    super(`Document rejected: ${result.reason}`);
    this.name = 'DocumentRejectedError';
    this.reason = result.reason;
    this.errors = result.errors;
  }
}

/** The submitting organisation is neither supplier nor customer on the invoice. */
export class NotAPartyError extends Error {
  constructor() {
    super('The submitting organisation is neither the supplier nor the customer of this invoice');
    this.name = 'NotAPartyError';
  }
}

export class IdempotencyConflictError extends Error {
  constructor(
    readonly conflict: 'key-reused' | 'duplicate-content',
    readonly existingDocumentId: string,
  ) {
    super(
      conflict === 'key-reused'
        ? 'The Idempotency-Key was already used for a document with different content'
        : 'This exact document was already submitted with another Idempotency-Key',
    );
    this.name = 'IdempotencyConflictError';
  }
}

export class DocumentNotFoundError extends Error {
  constructor(readonly documentId: string) {
    super(`Document ${documentId} not found`);
    this.name = 'DocumentNotFoundError';
  }
}
