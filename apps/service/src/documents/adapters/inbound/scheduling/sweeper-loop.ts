import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import {
  type SweepReport,
  StuckDocumentSweeper,
} from '../../../application/sweeper/stuck-document-sweeper';
import { SWEEPER_SETTINGS, type SweeperSettings } from './sweeper-settings';

/**
 * Runs the sweeper in every worker, once per interval (the first time one interval after startup).
 * Each requeued document gets a warning: it should not happen in normal operation, so it is the
 * hook for an alert. A failed sweep (e.g. the database is down) is logged and tried next time.
 */
@Injectable()
export class SweeperLoop implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(SweeperLoop.name);
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly sweeper: StuckDocumentSweeper,
    @Inject(SWEEPER_SETTINGS) private readonly settings: SweeperSettings,
  ) {}

  onApplicationBootstrap(): void {
    this.schedule();
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  /** One sweep; logs a warning per requeued document. */
  async sweep(): Promise<SweepReport> {
    const report = await this.sweeper.sweepOnce({ stuckAfterMs: this.settings.stuckAfterMs });
    for (const document of report.requeued) {
      this.logger.warn({
        msg: 'Stuck document requeued',
        documentId: document.documentId,
        status: document.status,
        attempt: document.attempt,
        unchangedSince: document.unchangedSince.toISOString(),
        reason: 'sweeper',
      });
    }
    return report;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), this.settings.intervalMs);
  }

  private async tick(): Promise<void> {
    try {
      await this.sweep();
    } catch (error) {
      this.logger.error(`Sweep failed, trying again later: ${(error as Error).message}`);
    }
    this.schedule();
  }
}
