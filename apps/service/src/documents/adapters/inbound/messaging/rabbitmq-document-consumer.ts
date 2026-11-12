import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type Provider,
} from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import type { Channel, ConsumeMessage } from 'amqplib';
import type { ChannelWrapper } from 'amqp-connection-manager';
import { ProcessDocumentCommand } from '../../../application/commands/process-document';
import type { ProcessDocumentMessage } from '../../../application/ports';
import { AmqpConnection } from '../../outbound/rabbitmq/amqp-connection';
import { requeueDelay } from '../../outbound/rabbitmq/rabbitmq-config';

/**
 * Inbound adapter for the worker: turns deliveries from `documents.process` into
 * ProcessDocumentCommands. It acks only after the handler resolved, so after its transaction
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
    private readonly commands: CommandBus,
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
      await this.commands.execute(toCommand(message)); // resolves after the commit
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

/** A malformed message throws, so it is requeued until the delivery limit sends it to the DLQ. */
function toCommand(message: ConsumeMessage): ProcessDocumentCommand {
  const payload = JSON.parse(message.content.toString('utf8')) as Partial<ProcessDocumentMessage>;
  const { documentId, attempt } = payload;
  if (typeof documentId !== 'string' || !Number.isInteger(attempt) || Number(attempt) < 1) {
    throw new Error('Malformed process message: documentId or attempt missing');
  }
  const messageId = String(message.properties.messageId);
  const correlationId: unknown = message.properties.headers?.['x-correlation-id'];
  return new ProcessDocumentCommand({
    documentId,
    attempt: Number(attempt),
    messageId,
    correlationId: typeof correlationId === 'string' ? correlationId : messageId,
  });
}

/** For the worker module (G07). Requires the providers from `rabbitMqProviders()`. */
export const messagingConsumers: Provider[] = [RabbitMqDocumentConsumer];
