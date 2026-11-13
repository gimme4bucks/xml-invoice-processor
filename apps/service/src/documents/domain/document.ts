import type { DocumentEvent, FailureReason, RequeueReason } from './document-events';
import { DomainError } from './errors';
import type {
  ContentHash,
  DocumentStatus,
  DocumentType,
  IdempotencyKey,
  InvoiceDirection,
  OrganisationId,
} from './value-objects';

/**
 * Processing attempts before a transient failure (VAT service unavailable) becomes permanent:
 * the first attempt plus one retry per delay queue (5 s, 30 s, 2 min; see `RoutingKeys.retry`).
 */
export const MAX_PROCESSING_ATTEMPTS = 4;

export interface ReceiveDocument {
  documentId: string;
  organisationId: OrganisationId;
  idempotencyKey: IdempotencyKey;
  contentHash: ContentHash;
  documentType: DocumentType;
  direction: InvoiceDirection;
}

/**
 * Event-sourced aggregate for one received document. State only changes through `apply`,
 * both when rehydrating from history and when recording new events.
 *
 * Lifecycle (status in brackets):
 *
 *   receive ──▶ [Received] ──startProcessing──▶ [Processing, attempt n running]
 *   attempt n running ──complete──────────────▶ [Completed]
 *   attempt n running ──fail──────────────────▶ [Failed]
 *   attempt n running ──recordTransientFailure─▶ [Processing, attempt n ended]  (n < max)
 *                                            └─▶ [Failed]                      (n = max)
 *   attempt n ended ────startProcessing───────▶ [Processing, attempt n+1 running]
 *   any non-final state ──requeue─────────────▶ (unchanged; records which attempt to ask for)
 *
 * Anything else is refused with a DomainError: `DOCUMENT_FINAL` once Completed or Failed,
 * `ATTEMPT_IN_PROGRESS` when starting while an attempt runs, and `NO_ATTEMPT_IN_PROGRESS` when
 * ending an attempt that is not running.
 */
export class Document {
  private state!: {
    documentId: string;
    organisationId: string;
    documentType: DocumentType;
    direction: InvoiceDirection;
    status: DocumentStatus;
    attempts: number;
    /** True from ProcessingStarted until that attempt completes, fails or fails transiently. */
    attemptInProgress: boolean;
    failure?: FailureReason;
  };
  /** Number of events already persisted; the expected version for the next append. */
  private persistedVersion = 0;
  private pending: DocumentEvent[] = [];

  private constructor() {}

  static receive(input: ReceiveDocument, now: Date): Document {
    const document = new Document();
    document.record({
      type: 'DocumentReceived',
      documentId: input.documentId,
      organisationId: input.organisationId.value,
      idempotencyKey: input.idempotencyKey.value,
      contentHash: input.contentHash.value,
      documentType: input.documentType,
      direction: input.direction,
      receivedAt: now.toISOString(),
    });
    return document;
  }

  static fromHistory(history: readonly DocumentEvent[]): Document {
    if (history[0]?.type !== 'DocumentReceived') {
      throw new DomainError('CORRUPT_STREAM', 'A document stream must start with DocumentReceived');
    }
    const document = new Document();
    for (const event of history) document.apply(event);
    document.persistedVersion = history.length;
    return document;
  }

  get id(): string {
    return this.state.documentId;
  }
  get organisationId(): string {
    return this.state.organisationId;
  }
  get documentType(): DocumentType {
    return this.state.documentType;
  }
  get direction(): InvoiceDirection {
    return this.state.direction;
  }
  get status(): DocumentStatus {
    return this.state.status;
  }
  /** Number of the latest attempt (0 before the first one started). */
  get attempts(): number {
    return this.state.attempts;
  }
  /** False once the latest attempt ended; a redelivered message for it has nothing left to do. */
  get attemptInProgress(): boolean {
    return this.state.attemptInProgress;
  }
  get failure(): FailureReason | undefined {
    return this.state.failure;
  }
  get isFinal(): boolean {
    return this.state.status === 'Completed' || this.state.status === 'Failed';
  }
  /** Version as persisted, i.e. the expected version when appending `pendingEvents`. */
  get version(): number {
    return this.persistedVersion;
  }
  get pendingEvents(): readonly DocumentEvent[] {
    return this.pending;
  }

  /** Call after the pending events were appended successfully. */
  markPersisted(): void {
    this.persistedVersion += this.pending.length;
    this.pending = [];
  }

  startProcessing(now: Date): void {
    this.assertNotFinal('start processing');
    if (this.state.attemptInProgress) {
      throw new DomainError(
        'ATTEMPT_IN_PROGRESS',
        `Cannot start processing: attempt ${this.state.attempts} is still in progress`,
      );
    }
    this.record({
      type: 'ProcessingStarted',
      attempt: this.state.attempts + 1,
      startedAt: now.toISOString(),
    });
  }

  /**
   * Records a transient failure of the running attempt. Returns `retry` when another attempt
   * is allowed; otherwise the document fails permanently and `exhausted` is returned.
   */
  recordTransientFailure(
    reason: FailureReason,
    now: Date,
    maxAttempts = MAX_PROCESSING_ATTEMPTS,
  ): 'retry' | 'exhausted' {
    this.assertAttemptInProgress('record a failed attempt');
    if (this.state.attempts >= maxAttempts) {
      this.fail(
        { ...reason, message: `${reason.message} (gave up after ${maxAttempts} attempts)` },
        now,
      );
      return 'exhausted';
    }
    this.record({
      type: 'ProcessingAttemptFailed',
      attempt: this.state.attempts,
      reason,
      failedAt: now.toISOString(),
    });
    return 'retry';
  }

  complete(resultKey: string, now: Date): void {
    this.assertAttemptInProgress('complete');
    this.record({ type: 'DocumentProcessed', resultKey, completedAt: now.toISOString() });
  }

  /** A permanent failure of the running attempt (e.g. a business rule or VAT number). */
  fail(reason: FailureReason, now: Date): void {
    this.assertAttemptInProgress('fail');
    this.record({ type: 'DocumentProcessingFailed', reason, failedAt: now.toISOString() });
  }

  /**
   * Sends a stuck document to the worker again (DLQ re-drive or sweeper). Returns the attempt the
   * new message must ask for: the running attempt while one is in progress, so the worker resumes
   * it, otherwise the next one. A final document is refused with `DOCUMENT_FINAL`.
   */
  requeue(reason: RequeueReason, now: Date): number {
    this.assertNotFinal('requeue');
    const attempt = this.state.attemptInProgress ? this.state.attempts : this.state.attempts + 1;
    this.record({ type: 'ProcessingRequeued', attempt, reason, requeuedAt: now.toISOString() });
    return attempt;
  }

  private record(event: DocumentEvent): void {
    this.apply(event);
    this.pending.push(event);
  }

  private apply(event: DocumentEvent): void {
    switch (event.type) {
      case 'DocumentReceived':
        this.state = {
          documentId: event.documentId,
          organisationId: event.organisationId,
          documentType: event.documentType,
          direction: event.direction,
          status: 'Received',
          attempts: 0,
          attemptInProgress: false,
        };
        return;
      case 'ProcessingStarted':
        this.state.status = 'Processing';
        this.state.attempts = event.attempt;
        this.state.attemptInProgress = true;
        return;
      case 'ProcessingAttemptFailed':
        // Stays Processing: the next attempt is scheduled.
        this.state.attemptInProgress = false;
        this.state.failure = event.reason;
        return;
      case 'DocumentProcessed':
        this.state.status = 'Completed';
        this.state.attemptInProgress = false;
        this.state.failure = undefined;
        return;
      case 'DocumentProcessingFailed':
        this.state.status = 'Failed';
        this.state.attemptInProgress = false;
        this.state.failure = event.reason;
        return;
      case 'ProcessingRequeued':
        // History only: the requeued message decides through the attempt it asks for.
        return;
    }
  }

  private assertNotFinal(action: string): void {
    if (this.isFinal) {
      throw new DomainError('DOCUMENT_FINAL', `Cannot ${action}: document is ${this.state.status}`);
    }
  }

  private assertAttemptInProgress(action: string): void {
    this.assertNotFinal(action);
    if (!this.state.attemptInProgress) {
      throw new DomainError(
        'NO_ATTEMPT_IN_PROGRESS',
        `Cannot ${action}: no processing attempt is in progress (document is ${this.state.status})`,
      );
    }
  }
}
