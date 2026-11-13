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

/** Who sent a stuck document to the worker again (ADR 0014). */
export type RequeueReason = 'dlq-redrive' | 'sweeper';

/**
 * A stuck document was sent to the worker again: its message ended in the dead-letter queue, or
 * the sweeper found it unchanged for too long. Only recorded; the state stays as it was.
 */
export interface ProcessingRequeued {
  type: 'ProcessingRequeued';
  /** The attempt the new message asks for. */
  attempt: number;
  reason: RequeueReason;
  requeuedAt: string;
}

export type DocumentEvent =
  | DocumentReceived
  | ProcessingStarted
  | ProcessingAttemptFailed
  | DocumentProcessed
  | DocumentProcessingFailed
  | ProcessingRequeued;

export type DocumentEventType = DocumentEvent['type'];
