import { Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { Channel } from 'amqplib';
import { type AmqpConnectionManager, type ChannelWrapper, connect } from 'amqp-connection-manager';
import type { RabbitMqConfig } from './rabbitmq-config';
import { assertTopology, type Topology, topologyFor } from './topology';

/**
 * Owns the process's single AMQP connection. amqp-connection-manager reconnects after a lost
 * connection and then re-runs every channel's setup (topology included) on a fresh channel.
 *
 * It does not reopen a channel that the broker closed with an error, and a failed setup leaves the
 * channel waiting forever. Those cases, and a consumer cancel, are therefore fatal: we log and exit,
 * and the restart policy starts a fresh process (ADR 0006).
 */
export class AmqpConnection implements OnApplicationShutdown {
  private readonly logger = new Logger(AmqpConnection.name);
  readonly manager: AmqpConnectionManager;
  readonly topology: Topology;
  private stopping = false;

  constructor(
    readonly config: RabbitMqConfig,
    private readonly onFatal: (reason: string) => void = () => process.exit(1),
  ) {
    this.topology = topologyFor(config);
    this.manager = connect([config.url], {
      heartbeatIntervalInSeconds: 5,
      reconnectTimeInSeconds: 1,
    });
    this.manager.on('connect', () => this.logger.log('Connected to RabbitMQ'));
    this.manager.on('disconnect', ({ err }) =>
      this.logger.warn(`Disconnected from RabbitMQ: ${err?.message ?? 'connection closed'}`),
    );
    this.manager.on('connectFailed', ({ err }) =>
      this.logger.warn(`Could not connect to RabbitMQ: ${err?.message}`),
    );
  }

  /**
   * Creates a channel that declares the topology and then runs `setup`, on the first connect and
   * after every reconnect.
   */
  createChannel<C extends Channel>(
    name: string,
    confirm: boolean,
    setup: (channel: C) => Promise<void>,
  ): ChannelWrapper {
    const wrapper = this.manager.createChannel({
      name,
      confirm,
      setup: async (channel: Channel) => {
        // A lost connection only emits `close`; `error` means the broker closed this channel.
        channel.on('error', (error: Error) =>
          this.fatal(`RabbitMQ closed the ${name} channel: ${error.message}`),
        );
        await assertTopology(channel, this.topology);
        await setup(channel as C); // a ConfirmChannel when `confirm` is set
      },
    });
    // For example a 406 because a queue already exists with other arguments.
    wrapper.on('error', (error: unknown) =>
      this.fatal(`Setting up the ${name} channel failed: ${(error as Error).message}`),
    );
    return wrapper;
  }

  /** Stops the process; the restart policy recovers what amqp-connection-manager cannot. */
  fatal(reason: string): void {
    if (this.stopping) return;
    this.stopping = true;
    this.logger.fatal(`${reason}. Exiting so that the worker restarts.`);
    this.onFatal(reason);
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    await this.manager.close();
  }
}
