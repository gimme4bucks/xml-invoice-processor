import { Injectable } from '@nestjs/common';
import { MessagePublisher, Outbox } from '../ports';

/**
 * Moves outbox messages to the broker. The only component that publishes (ADR 0004/0006).
 * A message is marked published only after the broker confirmed it; on failure it stays
 * pending and is retried on the next run, which can produce duplicates downstream.
 */
@Injectable()
export class OutboxRelay {
  constructor(
    private readonly outbox: Outbox,
    private readonly publisher: MessagePublisher,
  ) {}

  relayOnce(limit = 100): Promise<{ published: number; failed: number }> {
    return this.outbox.publishPending(limit, (message) =>
      this.publisher.publish(message.routingKey, message.payload, {
        messageId: message.id,
        headers: message.headers,
      }),
    );
  }
}
