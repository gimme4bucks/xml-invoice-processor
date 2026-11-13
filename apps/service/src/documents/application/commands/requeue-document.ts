import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import type { RequeueReason } from '../../domain/document-events';
import type { DocumentStatus } from '../../domain/value-objects';

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

@CommandHandler(RequeueDocumentCommand)
export class RequeueDocumentHandler implements ICommandHandler<
  RequeueDocumentCommand,
  RequeueResult
> {
  execute(): Promise<RequeueResult> {
    throw new Error('RequeueDocumentHandler is not implemented yet');
  }
}
