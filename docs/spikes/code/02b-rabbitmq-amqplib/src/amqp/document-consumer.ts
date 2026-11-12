import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { Channel, ConsumeMessage } from 'amqplib';
import type { ChannelWrapper } from 'amqp-connection-manager';
import { AmqpConnection } from './amqp-connection';
import { assertTopology, QUEUE } from './topology';

/** Must resolve only after the handler's DB transaction has committed. */
export type DocumentHandler = (payload: unknown, msg: ConsumeMessage) => Promise<void>;

export interface ConsumerHooks {
  /** Test-only seam: runs after the handler resolved, right before ack (T6). */
  beforeAck?: (msg: ConsumeMessage) => void;
}

const PREFETCH = 2;

@Injectable()
export class DocumentConsumer implements OnModuleDestroy {
  private readonly log = new Logger('DocumentConsumer');
  private wrapper?: ChannelWrapper;

  constructor(private readonly conn: AmqpConnection) {}

  /** Starts consuming; the setup re-runs (topology, prefetch, consume) on every reconnect. */
  async start(handler: DocumentHandler, hooks: ConsumerHooks = {}): Promise<void> {
    this.wrapper = this.conn.manager.createChannel({
      name: 'consumer',
      confirm: false,
      setup: async (ch: Channel) => {
        await assertTopology(ch);
        await ch.prefetch(PREFETCH);
        await ch.consume(QUEUE, (msg) => void this.onMessage(ch, msg, handler, hooks), { noAck: false });
      },
    });
    this.wrapper.on('error', (err) => this.log.error(`channel setup failed: ${(err as Error).message}`));
    await this.wrapper.waitForConnect();
  }

  /**
   * `ch` is the channel this delivery arrived on. Delivery tags are channel-scoped,
   * so we must ack/nack on exactly that channel, never on "the current" one
   * (ChannelWrapper.ack() would use the current channel after a reconnect).
   */
  private async onMessage(ch: Channel, msg: ConsumeMessage | null, handler: DocumentHandler, hooks: ConsumerHooks) {
    if (!msg) return this.log.warn('consumer cancelled by broker');

    let handled = true;
    try {
      await handler(JSON.parse(msg.content.toString()), msg); // == DB commit done
    } catch (err) {
      handled = false;
      this.log.warn(`handler failed for ${msg.properties.messageId}: ${(err as Error).message}`);
    }

    try {
      if (handled) {
        hooks.beforeAck?.(msg);
        ch.ack(msg); // ack strictly after commit
      } else {
        // Requeue so x-delivery-limit counts it, then DLQ. Must be basic.reject:
        // on RabbitMQ 4.x a basic.nack(requeue) does NOT count (endless loop, see T3).
        ch.reject(msg, true);
      }
    } catch (err) {
      // Channel died while we were handling: the broker requeues the unacked
      // delivery and redelivers it on the new channel (=> idempotent handler).
      this.log.warn(`could not settle ${msg.properties.messageId}: ${(err as Error).message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.wrapper?.close();
  }
}
