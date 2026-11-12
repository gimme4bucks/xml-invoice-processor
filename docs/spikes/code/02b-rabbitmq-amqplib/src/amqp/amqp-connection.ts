import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import amqp, { AmqpConnectionManager } from 'amqp-connection-manager';

export const AMQP_URL = Symbol('AMQP_URL');

/**
 * Owns the single AMQP connection. amqp-connection-manager reconnects on its own
 * (fixed delay); every channel created from it re-runs its setup function on
 * each reconnect.
 */
@Injectable()
export class AmqpConnection implements OnModuleDestroy {
  private readonly log = new Logger('AmqpConnection');
  readonly manager: AmqpConnectionManager;

  constructor(@Inject(AMQP_URL) url: string) {
    this.manager = amqp.connect([url], {
      heartbeatIntervalInSeconds: 5,
      reconnectTimeInSeconds: 1,
    });
    this.manager.on('connect', () => this.log.log('connected'));
    this.manager.on('disconnect', ({ err }) => this.log.warn(`disconnected: ${err?.message}`));
    this.manager.on('connectFailed', ({ err }) => this.log.warn(`connect failed: ${err?.message}`));
  }

  async onModuleDestroy(): Promise<void> {
    await this.manager.close();
  }
}
