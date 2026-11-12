import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import type { ChannelWrapper } from 'amqp-connection-manager';
import { AmqpConnection } from './amqp-connection';
import { assertTopology, EXCHANGE } from './topology';

export interface PublishOptions {
  messageId: string;
  headers?: Record<string, unknown>;
}

const CONFIRM_TIMEOUT_MS = 5_000;

/**
 * The outbox relay's only way to publish. publish() resolves only when the broker
 * has positively confirmed (basic.ack) this exact message on the channel it was
 * sent on. It rejects on nack, on unroutable (basic.return), on confirm timeout,
 * on channel/connection loss, and immediately when there is no live channel.
 *
 * Deliberately does NOT use ChannelWrapper.publish(): that one keeps messages in
 * an in-memory queue across reconnects and re-sends them later. The outbox is
 * already our durable queue, so we fail fast and let the relay retry the row.
 */
@Injectable()
export class ConfirmPublisher implements OnModuleDestroy {
  private readonly log = new Logger('ConfirmPublisher');
  private readonly wrapper: ChannelWrapper;
  private channel?: ConfirmChannel; // live raw confirm channel, or undefined while down
  private readonly returned = new Set<string>(); // messageIds bounced as unroutable

  constructor(conn: AmqpConnection) {
    this.wrapper = conn.manager.createChannel({
      name: 'publisher',
      confirm: true,
      // Runs on first connect and after every reconnect, on the fresh channel.
      setup: async (ch: ConfirmChannel) => {
        await assertTopology(ch);
        ch.on('return', (msg: ConsumeMessage) => this.returned.add(String(msg.properties.messageId)));
        ch.on('close', () => { if (this.channel === ch) this.channel = undefined; });
        this.channel = ch;
      },
    });
    this.wrapper.on('error', (err) => this.log.error(`channel setup failed: ${(err as Error).message}`));
  }

  /** Resolves once topology is declared and a confirm channel is live. */
  waitForReady(): Promise<void> {
    return this.wrapper.waitForConnect();
  }

  publish(routingKey: string, payload: unknown, opts: PublishOptions): Promise<void> {
    const ch = this.channel;
    if (!ch) return Promise.reject(new Error('publisher not connected'));

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err); else resolve();
      };
      const timer = setTimeout(() => settle(new Error('confirm timeout')), CONFIRM_TIMEOUT_MS);

      try {
        ch.publish(
          EXCHANGE,
          routingKey,
          Buffer.from(JSON.stringify(payload)),
          {
            persistent: true,
            mandatory: true, // unroutable -> basic.return (arrives before the ack)
            messageId: opts.messageId,
            contentType: 'application/json',
            headers: opts.headers,
          },
          // amqplib invokes this with an error on basic.nack AND when the channel
          // closes with this message still unconfirmed ("channel closed").
          (err: unknown) => {
            if (err) return settle(err instanceof Error ? err : new Error('nacked by broker'));
            if (this.returned.delete(opts.messageId)) return settle(new Error('unroutable (returned)'));
            settle();
          },
        );
      } catch (err) {
        settle(err as Error); // e.g. IllegalOperationError: channel closed
      }
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.wrapper.close();
  }
}
