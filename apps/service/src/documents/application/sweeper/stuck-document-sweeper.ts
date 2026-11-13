import { Injectable } from '@nestjs/common';
import type { DocumentStatus } from '../../domain/value-objects';
import { RequeueDocumentCommand, RequeueDocumentHandler } from '../commands/requeue-document';
import { Clock, ConcurrencyError, DocumentViews } from '../ports';

export interface SweepReport {
  /** Each one deserves a warning: the hook for an alert. */
  requeued: Array<{
    documentId: string;
    status: DocumentStatus;
    attempt: number;
    unchangedSince: Date;
  }>;
  /** Changed after it was found, e.g. requeued by another worker's sweeper or picked up after all. */
  skipped: number;
}

/**
 * Finds documents that are stuck for any reason (a lost or dead-lettered message, a bug) and
 * sends them to the worker again (ADR 0014). Stuck means: not final, read model unchanged for
 * `stuckAfterMs`, and no message waiting in the outbox. Safe with several workers: each requeue
 * expects the version that was found, so only one sweeper wins per document.
 */
@Injectable()
export class StuckDocumentSweeper {
  constructor(
    private readonly views: DocumentViews,
    private readonly requeue: RequeueDocumentHandler,
    private readonly clock: Clock,
  ) {}

  async sweepOnce(options: { stuckAfterMs: number; limit?: number }): Promise<SweepReport> {
    const updatedBefore = new Date(this.clock.now().getTime() - options.stuckAfterMs);
    const stuck = await this.views.findStuck({ updatedBefore, limit: options.limit ?? 100 });
    const report: SweepReport = { requeued: [], skipped: 0 };
    for (const document of stuck) {
      try {
        const result = await this.requeue.execute(
          new RequeueDocumentCommand({
            documentId: document.documentId,
            reason: 'sweeper',
            expectedVersion: document.version,
          }),
        );
        if (result.outcome !== 'requeued') {
          report.skipped++; // became final in the meantime
          continue;
        }
        report.requeued.push({
          documentId: document.documentId,
          status: result.status,
          attempt: result.attempt,
          unchangedSince: document.updatedAt,
        });
      } catch (error) {
        if (!(error instanceof ConcurrencyError)) throw error;
        report.skipped++;
      }
    }
    return report;
  }
}
