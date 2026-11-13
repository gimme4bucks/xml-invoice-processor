import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type Provider,
} from '@nestjs/common';
import type { Channel, ConsumeMessage } from 'amqplib';
import type { ChannelWrapper } from 'amqp-connection-manager';
import { AmqpConnection } from '../../outbound/rabbitmq/amqp-connection';
import { requeueDelay } from '../../outbound/rabbitmq/rabbitmq-config';
import {
  type IncomingProcessMessage,
  ProcessMessageDispatcher,
} from './process-message-dispatcher';

/**
 * Inbound adapter for the worker: hands deliveries from `documents.process` to the dispatcher,
 * which runs ProcessDocumentCommand and logs the outcome. It acks only after the handler resolved, so after its transaction
 * committed, and on the channel the delivery came from. A crash in between redelivers the message,
 * which the handler absorbs because it is idempotent (ADR 0004).
 */
@Injectable()
export class RabbitMqDocumentConsumer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RabbitMqDocumentConsumer.name);
  private wrapper?: ChannelWrapper;
  private subscription?: { channel: Channel; consumerTag: string };
  private readonly inFlight = new Set<Promise<void>>();
  private stopping = false;

  constructor(
    private readonly connection: AmqpConnection,
    private readonly dispatcher: ProcessMessageDispatcher,
  ) {}

  /** Subscribes on every (re)connect. Startup does not wait for the broker to be reachable. */
  onApplicationBootstrap(): void {
    this.wrapper = this.connection.createChannel('consumer', false, async (channel: Channel) => {
      await channel.prefetch(this.connection.config.prefetch);
      const { consumerTag } = await channel.consume(
        this.connection.topology.processQueue,
        (message) => this.track(this.handle(channel, message)),
        { noAck: false },
      );
      this.subscription = { channel, consumerTag };
    });
  }

  /** Resolves once the consumer is subscribed. */
  waitUntilConsuming(): Promise<void> {
    if (!this.wrapper) return Promise.reject(new Error('The consumer has not been started'));
    return this.wrapper.waitForConnect();
  }

  /** Graceful stop: no new deliveries, let the running ones commit and ack, then close. */
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    const subscription = this.subscription;
    if (subscription) {
      await subscription.channel.cancel(subscription.consumerTag).catch(() => undefined);
    }
    await Promise.allSettled(this.inFlight);
    await this.wrapper?.close();
  }

  private track(handling: Promise<void>): void {
    this.inFlight.add(handling);
    void handling.finally(() => this.inFlight.delete(handling));
  }

  private async handle(channel: Channel, message: ConsumeMessage | null): Promise<void> {
    if (!message) {
      // The broker cancelled the consumer, for example because the queue was deleted.
      if (!this.stopping) this.connection.fatal('RabbitMQ cancelled the document consumer');
      return;
    }
    const messageId = String(message.properties.messageId);
    try {
      await this.dispatcher.dispatch(incoming(message)); // resolves after the commit
    } catch (error) {
      const deliveries = Number(message.properties.headers?.['x-delivery-count'] ?? 0);
      const delayMs = requeueDelay(deliveries, this.connection.config.requeueDelayMs);
      this.logger.warn(
        `Message ${messageId} failed, requeueing it in ${delayMs} ms: ${(error as Error).message}`,
      );
      // Back off before requeueing. Holding the delivery also takes a prefetch slot, so during an
      // outage (e.g. Postgres down) the worker slows down instead of dead-lettering everything.
      if (!this.stopping) await new Promise((resolve) => setTimeout(resolve, delayMs));
      // basic.reject, never basic.nack: on RabbitMQ 4.4 only reject counts toward
      // x-delivery-limit, so a poison message ends in the DLQ instead of looping (spike 02b, T3).
      return this.settle(messageId, () => channel.reject(message, true));
    }
    this.settle(messageId, () => channel.ack(message));
  }

  private settle(messageId: string, settle: () => void): void {
    try {
      settle();
    } catch (error) {
      // The channel closed meanwhile; the broker redelivers the message on the next channel.
      this.logger.warn(`Could not settle message ${messageId}: ${(error as Error).message}`);
    }
  }
}

/** The body is JSON; anything else becomes a malformed message that the dispatcher rejects. */
function incoming(message: ConsumeMessage): IncomingProcessMessage {
  let payload: unknown;
  try {
    payload = JSON.parse(message.content.toString('utf8'));
  } catch {
    payload = undefined;
  }
  return {
    payload,
    messageId: String(message.properties.messageId),
    headers: message.properties.headers ?? {},
  };
}

/** For the worker module (G07). Requires the providers from `rabbitMqProviders()`. */
export const messagingConsumers: Provider[] = [RabbitMqDocumentConsumer, ProcessMessageDispatcher];
