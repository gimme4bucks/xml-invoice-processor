import type { OnModuleDestroy } from '@nestjs/common';
import type { ConfirmChannel, Message } from 'amqplib';
import type { ChannelWrapper } from 'amqp-connection-manager';
import {
  MessagePublisher,
  type PublishOptions,
  PublishFailedError,
} from '../../../application/ports';
import { AmqpConnection } from './amqp-connection';

/** Without a confirm by then, the outcome is unknown and the relay publishes the row again. */
const CONFIRM_TIMEOUT_MS = 5_000;

/** The live confirm channel, and the messages the broker returned on it as unroutable. */
interface LiveChannel {
  channel: ConfirmChannel;
  returned: Set<string>;
}

/**
 * The outbox relay's way to publish (ADR 0004/0006). `publish` resolves only inside the broker's
 * confirm callback for this message. It rejects with PublishFailedError on a nack, an unroutable
 * message (`mandatory`), a confirm timeout, a closed channel, and immediately when not connected.
 *
 * It deliberately does not use amqp-connection-manager's publish, which buffers messages in memory
 * across reconnects. The outbox is already the durable buffer and the relay the retry loop.
 */
export class RabbitMqPublisher implements MessagePublisher, OnModuleDestroy {
  private readonly wrapper: ChannelWrapper;
  private live?: LiveChannel;

  constructor(private readonly connection: AmqpConnection) {
    this.wrapper = connection.createChannel('publisher', true, async (channel: ConfirmChannel) => {
      const live: LiveChannel = { channel, returned: new Set() };
      // The broker confirms an unroutable message too, but sends basic.return before the ack.
      channel.on('return', (message: Message) =>
        live.returned.add(String(message.properties.messageId)),
      );
      channel.on('close', () => {
        if (this.live === live) this.live = undefined;
      });
      this.live = live;
    });
  }

  /** Resolves once the topology is declared and a confirm channel is live. */
  waitUntilConnected(): Promise<void> {
    return this.wrapper.waitForConnect();
  }

  publish(
    routingKey: string,
    payload: Record<string, unknown>,
    options: PublishOptions,
  ): Promise<void> {
    const live = this.live;
    if (!live) return Promise.reject(new PublishFailedError('not connected to RabbitMQ'));

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (failure?: string): void => {
        if (settled) return; // the first outcome wins, e.g. a late ack after the timeout
        settled = true;
        clearTimeout(timer);
        if (failure === undefined) resolve();
        else reject(new PublishFailedError(failure));
      };
      const timer = setTimeout(
        () => settle(`no confirm within ${CONFIRM_TIMEOUT_MS} ms`),
        CONFIRM_TIMEOUT_MS,
      );

      try {
        live.channel.publish(
          this.connection.topology.exchange,
          routingKey,
          Buffer.from(JSON.stringify(payload)),
          {
            persistent: true,
            mandatory: true,
            messageId: options.messageId,
            contentType: 'application/json',
            headers: options.headers,
          },
          // amqplib calls this on basic.ack, on basic.nack, and when the channel closes first.
          (error: unknown) => {
            if (error) return settle(error instanceof Error ? error.message : 'nacked');
            if (live.returned.delete(options.messageId)) return settle('unroutable (returned)');
            settle();
          },
        );
      } catch (error) {
        settle(error instanceof Error ? error.message : String(error)); // channel just closed
      }
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.wrapper.close();
  }
}
