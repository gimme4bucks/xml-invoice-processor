import type { DocumentEvent, DocumentReceived, FailureReason } from './document-events';
import { DomainError } from './errors';
import type { DocumentStatus, DocumentType, InvoiceDirection } from './value-objects';

/** Default number of processing attempts before a transient failure becomes permanent. */
export const MAX_PROCESSING_ATTEMPTS = 4;

/**
 * Event-sourced aggregate for one received document. State only changes through `apply`,
 * both when rehydrating from history and when recording new events.
 */
export class Document {
  private state!: {
    documentId: string;
    organisationId: string;
    documentType: DocumentType;
    direction: InvoiceDirection;
    status: DocumentStatus;
    attempts: number;
    failure?: FailureReason;
  };
  /** Number of events already persisted; the expected version for the next append. */
  private persistedVersion = 0;
  private pending: DocumentEvent[] = [];

  private constructor() {}

  static receive(input: Omit<DocumentReceived, 'type' | 'receivedAt'>, now: Date): Document {
    const document = new Document();
    document.record({ type: 'DocumentReceived', ...input, receivedAt: now.toISOString() });
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
  get attempts(): number {
    return this.state.attempts;
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
    this.record({
      type: 'ProcessingStarted',
      attempt: this.state.attempts + 1,
      startedAt: now.toISOString(),
    });
  }

  /**
   * Records a transient failure of the current attempt. Returns `retry` when another attempt
   * is allowed; otherwise the document fails permanently and `exhausted` is returned.
   */
  recordTransientFailure(
    reason: FailureReason,
    now: Date,
    maxAttempts = MAX_PROCESSING_ATTEMPTS,
  ): 'retry' | 'exhausted' {
    this.assertProcessing('record a failed attempt');
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
    this.assertProcessing('complete');
    this.record({ type: 'DocumentProcessed', resultKey, completedAt: now.toISOString() });
  }

  fail(reason: FailureReason, now: Date): void {
    this.assertNotFinal('fail');
    this.record({ type: 'DocumentProcessingFailed', reason, failedAt: now.toISOString() });
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
        };
        return;
      case 'ProcessingStarted':
        this.state.status = 'Processing';
        this.state.attempts = event.attempt;
        return;
      case 'ProcessingAttemptFailed':
        // Stays Processing: the next attempt is scheduled.
        this.state.failure = event.reason;
        return;
      case 'DocumentProcessed':
        this.state.status = 'Completed';
        this.state.failure = undefined;
        return;
      case 'DocumentProcessingFailed':
        this.state.status = 'Failed';
        this.state.failure = event.reason;
        return;
    }
  }

  private assertNotFinal(action: string): void {
    if (this.isFinal) {
      throw new DomainError('DOCUMENT_FINAL', `Cannot ${action}: document is ${this.state.status}`);
    }
  }

  private assertProcessing(action: string): void {
    if (this.state.status !== 'Processing') {
      throw new DomainError(
        'DOCUMENT_NOT_PROCESSING',
        `Cannot ${action}: document is ${this.state.status}`,
      );
    }
  }
}
