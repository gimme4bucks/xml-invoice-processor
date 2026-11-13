import { Injectable } from '@nestjs/common';
import type { DocumentStatus } from '../../domain/value-objects';
import { RequeueDocumentHandler } from '../commands/requeue-document';
import { Clock, DocumentViews } from '../ports';

export interface SweepReport {
  /** Each one deserves a warning: the hook for an alert. */
  requeued: Array<{ documentId: string; status: DocumentStatus; attempt: number; unchangedSince: Date }>;
  /** Changed after it was found, e.g. requeued by another worker's sweeper or picked up after all. */
  skipped: number;
}

@Injectable()
export class StuckDocumentSweeper {
  constructor(
    private readonly views: DocumentViews,
    private readonly requeue: RequeueDocumentHandler,
    private readonly clock: Clock,
  ) {}

  sweepOnce(_options: { stuckAfterMs: number; limit?: number }): Promise<SweepReport> {
    throw new Error('StuckDocumentSweeper is not implemented yet');
  }
}
