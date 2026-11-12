import { Inject, Injectable } from '@nestjs/common';
import { MessageErrorHandler, RabbitSubscribe } from '@golevelup/nestjs-rabbitmq';
import type { Channel, ConsumeMessage } from 'amqplib';
import { CONSUMER_CHANNEL, PROCESS_QUEUE } from './topology';

export interface DeliveryMeta {
  messageId: string;
  redelivered: boolean;
  deliveryCount: number;
  headers: Record<string, unknown>;
}

/** Business logic incl. the DB transaction. Must resolve only after the commit. */
export interface DocumentHandler {
  handle(payload: unknown, meta: DeliveryMeta): Promise<void>;
}
export const DOCUMENT_HANDLER = Symbol('DOCUMENT_HANDLER');

/**
 * Requeue on failure with basic.REJECT(requeue=true), not basic.nack.
 * Verified on RabbitMQ 4.4.0: a quorum queue increments x-delivery-count (and enforces
 * x-delivery-limit) for basic.reject(requeue) and for channel close, but NOT for
 * basic.nack(requeue) -- only x-acquired-count grows, so a poison message loops forever.
 * The library's built-in requeueErrorHandler / `Nack` response both use basic.nack.
 */
export const rejectRequeueErrorHandler: MessageErrorHandler = (channel: Channel, msg: ConsumeMessage | ConsumeMessage[]) => {
  for (const m of Array.isArray(msg) ? msg : [msg]) channel.reject(m, true);
};

@Injectable()
export class DocumentConsumer {
  constructor(@Inject(DOCUMENT_HANDLER) private readonly handler: DocumentHandler) {}

  @RabbitSubscribe({
    queue: PROCESS_QUEUE,
    createQueueIfNotExists: false, // topology is owned by the module config (checkQueue only)
    queueOptions: { channel: CONSUMER_CHANNEL }, // prefetch 2 channel
    // Throw => basic.reject(requeue=true). Quorum queue counts it (x-delivery-count) and
    // dead-letters to documents.dlx once x-delivery-limit is exceeded.
    errorHandler: rejectRequeueErrorHandler,
  })
  async onMessage(payload: unknown, msg: ConsumeMessage): Promise<void> {
    const headers = (msg.properties.headers ?? {}) as Record<string, unknown>;
    await this.handler.handle(payload, {
      messageId: String(msg.properties.messageId),
      redelivered: msg.fields.redelivered,
      deliveryCount: Number(headers['x-delivery-count'] ?? 0),
      headers,
    });
    // Returning (void) => the library calls channel.ack(msg) AFTER this promise resolved.
  }
}
