import { Injectable } from '@nestjs/common';
import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import type { Options } from 'amqplib';
import { EXCHANGE } from './topology';

export const PUBLISH_TIMEOUT_MS = 5000;

export interface PublishOpts {
  messageId: string;
  headers?: Record<string, unknown>;
}

@Injectable()
export class DocumentPublisher {
  constructor(private readonly amqp: AmqpConnection) {}

  /**
   * Resolves only after the broker confirmed (basic.ack) the message.
   * AmqpConnection.publish -> amqp-connection-manager ChannelWrapper.publish on a ConfirmChannel
   * (golevelup creates every channel with the wrapper default confirm:true).
   * Rejects on: broker nack ('message nacked'), channel/connection loss while unconfirmed
   * ('channel closed'), or `timeout` ms without a confirm (e.g. broker down; message is dropped
   * from the wrapper's send queue so it is NOT sent later).
   */
  async publish(routingKey: string, payload: unknown, opts: PublishOpts): Promise<void> {
    await this.amqp.publish(EXCHANGE, routingKey, payload, {
      messageId: opts.messageId,
      headers: opts.headers,
      persistent: true,
      contentType: 'application/json',
      // `timeout` is not in amqplib's Options.Publish type, but ChannelWrapper.publish reads it.
      timeout: PUBLISH_TIMEOUT_MS,
    } as Options.Publish);
  }
}
