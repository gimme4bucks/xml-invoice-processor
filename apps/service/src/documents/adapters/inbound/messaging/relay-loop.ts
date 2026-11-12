import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { OutboxRelay } from '../../../application/relay/outbox-relay';

/** Polls the outbox. Fast while there is work, backs off when idle or when publishing fails. */
@Injectable()
export class RelayLoop implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(RelayLoop.name);
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(private readonly relay: OutboxRelay) {}

  onApplicationBootstrap(): void {
    this.schedule(0);
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  private async tick(): Promise<void> {
    let next = 1000;
    try {
      const { published, failed } = await this.relay.relayOnce();
      if (failed > 0)
        this.logger.warn(`Outbox relay: ${failed} message(s) not confirmed, will retry`);
      else if (published > 0) next = 0;
      else next = 200;
    } catch (error) {
      this.logger.error(`Outbox relay run failed: ${(error as Error).message}`);
    }
    this.schedule(next);
  }
}
