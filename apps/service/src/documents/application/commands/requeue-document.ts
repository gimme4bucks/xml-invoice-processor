import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { Document } from '../../domain/document';
import type { RequeueReason } from '../../domain/document-events';
import type { DocumentStatus } from '../../domain/value-objects';
import { buildView } from '../document-view';
import {
  Clock,
  ConcurrencyError,
  DocumentViews,
  EventStore,
  IdGenerator,
  Outbox,
  type ProcessDocumentMessage,
  RoutingKeys,
  UnitOfWork,
} from '../ports';

export class RequeueDocumentCommand {
  constructor(
    readonly input: {
      documentId: string;
      reason: RequeueReason;
      /**
       * The stream version the caller saw (the sweeper: the stuck read model row). A document
       * that changed since is not requeued: the append fails with ConcurrencyError.
       */
      expectedVersion?: number;
      /** What caused the requeue, e.g. the id of the dead-lettered message. */
      causationId?: string;
      /** Decide and report, but write nothing (`xip redrive --dry-run`). */
      dryRun?: boolean;
    },
  ) {}
}

export type RequeueResult =
  | { outcome: 'requeued'; status: DocumentStatus; attempt: number }
  | { outcome: 'already-final'; status: DocumentStatus }
  | { outcome: 'not-found' };

/**
 * Sends a stuck document to the worker again (ADR 0014): its message ended in the dead-letter
 * queue, or the sweeper found it unchanged for too long. In one unit of work it records
 * ProcessingRequeued, updates the read model and writes a `process` message to the outbox; the
 * relay publishes it like any other. No second idempotency mechanism: the worker's handler decides
 * from the document's state whether the message still has work to do, and the append's
 * optimistic concurrency lets at most one of several concurrent requeues win.
 */
@CommandHandler(RequeueDocumentCommand)
export class RequeueDocumentHandler implements ICommandHandler<
  RequeueDocumentCommand,
  RequeueResult
> {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly events: EventStore,
    private readonly views: DocumentViews,
    private readonly outbox: Outbox,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  execute({ input }: RequeueDocumentCommand): Promise<RequeueResult> {
    return this.uow.run(async (tx) => {
      const history = await this.events.load(input.documentId);
      const first = history[0];
      if (!first) return { outcome: 'not-found' };
      const document = Document.fromHistory(history.map((stored) => stored.event));
      if (document.isFinal) return { outcome: 'already-final', status: document.status };
      if (input.expectedVersion !== undefined && input.expectedVersion !== document.version) {
        throw new ConcurrencyError(document.id, input.expectedVersion);
      }

      const attempt = document.requeue(input.reason, this.clock.now());
      const result = { outcome: 'requeued', status: document.status, attempt } as const;
      if (input.dryRun) return result;

      // The intake's correlation id, so the document's log lines can be followed end to end.
      const { correlationId } = first.metadata;
      const stored = await this.events.append(
        document.id,
        document.version,
        document.pendingEvents,
        {
          correlationId,
          ...(input.causationId ? { causationId: input.causationId } : {}),
          actor: input.reason,
        },
        tx,
      );
      await this.views.upsert(buildView([...history, ...stored]), tx);
      const payload: ProcessDocumentMessage = { documentId: document.id, attempt };
      await this.outbox.enqueue(
        [
          {
            id: this.ids.newId(),
            routingKey: RoutingKeys.process,
            payload,
            headers: { 'x-correlation-id': correlationId },
          },
        ],
        tx,
      );
      return result;
    });
  }
}
