import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { BlobReferences } from './blob-references';
import { ObjectStore } from './object-store';
import { ORPHAN_SWEEP_SETTINGS, type OrphanSweepSettings } from './s3-config';

export interface OrphanReport {
  /** Objects old enough to be looked at. */
  examined: number;
  /** Of those, the ones no blob referenced, now deleted. */
  removed: number;
}

/**
 * Deletes objects that no blob references (ADR 0016): the upload of a unit of work that rolled
 * back, or of a process that died before its commit. Only objects written before the cutoff are
 * looked at, and each one is deleted under BlobReferences' exclusive hold: a writer that holds the
 * hash (uploaded, not yet committed) makes the collector skip it, and a writer that arrives during
 * the delete waits and uploads the object again. Safe to run in several workers at once.
 */
@Injectable()
export class OrphanObjectCollector {
  constructor(
    private readonly objects: ObjectStore,
    private readonly references: BlobReferences,
  ) {}

  async collect(writtenBefore: Date): Promise<OrphanReport> {
    const report: OrphanReport = { examined: 0, removed: 0 };
    for await (const object of this.objects.list()) {
      if (object.lastModified >= writtenBefore) continue;
      report.examined++;
      const removed = await this.references.removeIfUnreferenced(object.sha256, () =>
        this.objects.delete(object.sha256),
      );
      if (removed) report.removed++;
    }
    return report;
  }
}

/**
 * Runs the collector in every worker, once per interval (the first time one interval after
 * startup). The workers may overlap: the locks make that safe. A failed run (the object store or
 * the database is down) is logged and tried again next time; orphans only cost storage meanwhile.
 */
@Injectable()
export class OrphanSweepLoop implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OrphanSweepLoop.name);
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly collector: OrphanObjectCollector,
    @Inject(ORPHAN_SWEEP_SETTINGS) private readonly settings: OrphanSweepSettings,
  ) {}

  onApplicationBootstrap(): void {
    this.schedule();
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), this.settings.intervalMs);
  }

  private async tick(): Promise<void> {
    try {
      const report = await this.collector.collect(new Date(Date.now() - this.settings.minAgeMs));
      this.logger.log({ msg: 'Orphan objects collected', ...report });
    } catch (error) {
      this.logger.error(`Orphan sweep failed, trying again later: ${(error as Error).message}`);
    }
    this.schedule();
  }
}
