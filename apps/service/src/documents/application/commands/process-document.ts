import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { Document } from '../../domain/document';
import type { FailureReason } from '../../domain/document-events';
import { buildView, originalBlobKey, resultBlobKey } from '../document-view';
import {
  BlobStore,
  BusinessRuleValidator,
  Clock,
  ConcurrencyError,
  DocumentViews,
  EventStore,
  IdGenerator,
  InvoiceMapper,
  Outbox,
  RoutingKeys,
  type Transaction,
  UnitOfWork,
  VatNumberVerifier,
  VatServiceUnavailableError,
} from '../ports';

export class ProcessDocumentCommand {
  constructor(
    readonly input: {
      documentId: string;
      /** The attempt the message asks for (1 for the first). */
      attempt: number;
      messageId: string;
      correlationId: string;
    },
  ) {}
}

export type ProcessOutcome =
  | 'completed'
  | 'failed'
  | 'retry-scheduled'
  /** Duplicate or stale message; nothing to do (the consumer still acks). */
  | 'skipped';

/**
 * Worker side. Idempotent: the document's own state decides whether a (re)delivered message
 * still has work to do, and appends use optimistic concurrency, so concurrent duplicates
 * result in exactly one winner.
 */
@CommandHandler(ProcessDocumentCommand)
export class ProcessDocumentHandler implements ICommandHandler<
  ProcessDocumentCommand,
  ProcessOutcome
> {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly events: EventStore,
    private readonly views: DocumentViews,
    private readonly blobs: BlobStore,
    private readonly outbox: Outbox,
    private readonly rules: BusinessRuleValidator,
    private readonly mapper: InvoiceMapper,
    private readonly vat: VatNumberVerifier,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute({ input }: ProcessDocumentCommand): Promise<ProcessOutcome> {
    try {
      return await this.process(input);
    } catch (error) {
      if (error instanceof ConcurrencyError) return 'skipped'; // another delivery won
      throw error;
    }
  }

  private async process(input: ProcessDocumentCommand['input']): Promise<ProcessOutcome> {
    const document = await this.claimAttempt(input);
    if (!document) return 'skipped';

    const original = await this.blobs.get(originalBlobKey(document.id));
    if (!original) throw new Error(`Original XML of document ${document.id} is missing`);

    const fatal = (await this.rules.validate(original.content)).filter((v) => v.flag === 'fatal');
    if (fatal.length > 0) {
      return this.failPermanently(document, input, {
        code: 'BUSINESS_RULES_VIOLATED',
        message: `${fatal.length} EN 16931 / Peppol rule(s) violated`,
        violations: fatal,
      });
    }

    const invoice = this.mapper.map(original.content);
    const counterparty = document.direction === 'purchase' ? invoice.supplier : invoice.customer;
    if (counterparty.vatNumber) {
      try {
        const verdict = await this.vat.verify(counterparty.vatNumber);
        if (verdict === 'invalid') {
          return this.failPermanently(document, input, {
            code: 'VAT_NUMBER_INVALID',
            message: `VAT number ${counterparty.vatNumber} of the counterparty does not exist`,
          });
        }
      } catch (error) {
        if (!(error instanceof VatServiceUnavailableError)) throw error;
        return this.recordTransientFailure(document, input, {
          code: 'VAT_SERVICE_UNAVAILABLE',
          message: error.message,
        });
      }
    }

    const result = { documentId: document.id, direction: document.direction, invoice };
    return this.save(document, input, 'completed', async (doc, tx) => {
      await this.blobs.put(
        {
          key: resultBlobKey(doc.id),
          contentType: 'application/json',
          content: Buffer.from(JSON.stringify(result)),
        },
        tx,
      );
      doc.complete(resultBlobKey(doc.id), this.clock.now());
    });
  }

  /** Records ProcessingStarted for this attempt, or returns undefined when there is nothing to do. */
  private async claimAttempt(
    input: ProcessDocumentCommand['input'],
  ): Promise<Document | undefined> {
    return this.uow.run(async (tx) => {
      const history = await this.events.load(input.documentId);
      if (history.length === 0) return undefined;
      const document = Document.fromHistory(history.map((stored) => stored.event));
      if (document.isFinal || document.attempts > input.attempt) return undefined;
      // attempts === input.attempt: a redelivery after a crash mid-attempt; resume without a new event.
      if (document.attempts < input.attempt) {
        document.startProcessing(this.clock.now());
        const stored = await this.events.append(
          document.id,
          document.version,
          document.pendingEvents,
          this.metadata(input),
          tx,
        );
        document.markPersisted();
        await this.views.upsert(buildView([...history, ...stored]), tx);
      }
      return document;
    });
  }

  private failPermanently(
    document: Document,
    input: ProcessDocumentCommand['input'],
    reason: FailureReason,
  ): Promise<ProcessOutcome> {
    return this.save(document, input, 'failed', async (doc) => doc.fail(reason, this.clock.now()));
  }

  private recordTransientFailure(
    document: Document,
    input: ProcessDocumentCommand['input'],
    reason: FailureReason,
  ): Promise<ProcessOutcome> {
    return this.save(document, input, 'retry-scheduled', async (doc, tx) => {
      if (doc.recordTransientFailure(reason, this.clock.now()) === 'exhausted') return 'failed';
      // Back off: 1st retry after 5s, 2nd after 30s, then every 2m (delay queues, see ADR 0006).
      const delays = RoutingKeys.retry;
      const routingKey = delays[Math.min(doc.attempts - 1, delays.length - 1)] ?? delays[0];
      await this.outbox.enqueue(
        [
          {
            id: this.ids.newId(),
            routingKey,
            payload: { documentId: doc.id, attempt: doc.attempts + 1 },
            headers: { 'x-correlation-id': input.correlationId },
          },
        ],
        tx,
      );
    });
  }

  /**
   * Re-loads the stream, applies `change` and appends in one transaction (expected version
   * check). `change` may override the outcome.
   */
  private save(
    document: Document,
    input: ProcessDocumentCommand['input'],
    outcome: ProcessOutcome,
    change: (doc: Document, tx: Transaction) => Promise<ProcessOutcome | void>,
  ): Promise<ProcessOutcome> {
    return this.uow.run(async (tx) => {
      const history = await this.events.load(document.id);
      const current = Document.fromHistory(history.map((stored) => stored.event));
      if (current.isFinal || current.attempts !== document.attempts) return 'skipped';
      const override = await change(current, tx);
      const stored = await this.events.append(
        current.id,
        current.version,
        current.pendingEvents,
        this.metadata(input),
        tx,
      );
      current.markPersisted();
      await this.views.upsert(buildView([...history, ...stored]), tx);
      return override ?? outcome;
    });
  }

  private metadata(input: ProcessDocumentCommand['input']) {
    return { correlationId: input.correlationId, causationId: input.messageId, actor: 'worker' };
  }
}
