import type { DocumentType, InvoiceDirection } from './value-objects';

/** One violated Schematron (EN 16931 / Peppol) rule, as reported in SVRL. */
export interface RuleViolation {
  ruleId: string;
  flag: 'fatal' | 'warning';
  message: string;
  location: string;
}

export interface FailureReason {
  /** Stable, machine-readable code, e.g. `BUSINESS_RULES_VIOLATED`, `VAT_NUMBER_INVALID`. */
  code: string;
  message: string;
  violations?: RuleViolation[];
}

// Timestamps are ISO-8601 strings so events serialise to JSON unchanged.

export interface DocumentReceived {
  type: 'DocumentReceived';
  documentId: string;
  organisationId: string;
  idempotencyKey: string;
  contentHash: string;
  documentType: DocumentType;
  direction: InvoiceDirection;
  receivedAt: string;
}

export interface ProcessingStarted {
  type: 'ProcessingStarted';
  attempt: number;
  startedAt: string;
}

/** A transient failure; another attempt follows. */
export interface ProcessingAttemptFailed {
  type: 'ProcessingAttemptFailed';
  attempt: number;
  reason: FailureReason;
  failedAt: string;
}

export interface DocumentProcessed {
  type: 'DocumentProcessed';
  resultKey: string;
  completedAt: string;
}

/** A permanent failure; the document will not be processed again. */
export interface DocumentProcessingFailed {
  type: 'DocumentProcessingFailed';
  reason: FailureReason;
  failedAt: string;
}

export type DocumentEvent =
  | DocumentReceived
  | ProcessingStarted
  | ProcessingAttemptFailed
  | DocumentProcessed
  | DocumentProcessingFailed;

export type DocumentEventType = DocumentEvent['type'];
