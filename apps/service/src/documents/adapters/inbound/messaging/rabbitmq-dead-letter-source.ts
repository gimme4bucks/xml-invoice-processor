import type { OnModuleDestroy } from '@nestjs/common';
import type { Channel } from 'amqplib';
import type { ChannelWrapper } from 'amqp-connection-manager';
import { AmqpConnection } from '../../outbound/rabbitmq/amqp-connection';
import { type DeadLetter, DeadLetterSource } from './dlq-redrive';

/** A redrive is run by hand: report an unreachable broker instead of waiting for it. */
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Reads `documents.dlq` one message at a time with basic.get (no consumer, no prefetch), for
 * `xip redrive`. A taken message stays unacked until the redrive settles it, so the broker does
 * not hand it out again in the same run.
 *
 * Releasing uses basic.nack with requeue, deliberately not basic.reject (the opposite of hard
 * rule 5, for the opposite reason). The DLQ is a quorum queue without an explicit delivery limit,
 * so RabbitMQ 4.4 applies the default of 20, and it has no dead-letter target of its own: a
 * message returned 20 times by reject, or by closing the channel, is dropped. A nack does not
 * count, so a message can be left in the DLQ for any number of runs (contract test).
 */
export class RabbitMqDeadLetterSource extends DeadLetterSource implements OnModuleDestroy {
  private readonly wrapper: ChannelWrapper;
  private channel?: Channel;

  constructor(private readonly connection: AmqpConnection) {
    super();
    this.wrapper = connection.createChannel('redrive', false, async (channel: Channel) => {
      this.channel = channel;
    });
  }

  async count(): Promise<number> {
    const channel = await this.live();
    return (await channel.checkQueue(this.connection.topology.deadLetterQueue)).messageCount;
  }

  async next(): Promise<DeadLetter | undefined> {
    const channel = await this.live();
    const message = await channel.get(this.connection.topology.deadLetterQueue, { noAck: false });
    if (!message) return undefined;
    const messageId: unknown = message.properties.messageId;
    return {
      messageId: typeof messageId === 'string' ? messageId : '(no message id)',
      payload: parseJson(message.content),
      // Settled on the channel the message came from (hard rule 5).
      ack: () => channel.ack(message),
      release: () => {
        try {
          channel.nack(message, false, true);
        } catch {
          // The channel is closed: the broker has already put the message back.
        }
      },
    };
  }

  async onModuleDestroy(): Promise<void> {
    await this.wrapper.close();
  }

  private async live(): Promise<Channel> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`RabbitMQ not reachable within ${CONNECT_TIMEOUT_MS} ms`)),
        CONNECT_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([this.wrapper.waitForConnect(), timeout]);
    } finally {
      clearTimeout(timer);
    }
    if (!this.channel) throw new Error('The redrive channel is not open');
    return this.channel;
  }
}

function parseJson(content: Buffer): unknown {
  try {
    return JSON.parse(content.toString('utf8'));
  } catch {
    return undefined;
  }
}
