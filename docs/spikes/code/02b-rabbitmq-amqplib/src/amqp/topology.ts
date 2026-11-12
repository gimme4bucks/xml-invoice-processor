import type { Channel } from 'amqplib';

export const EXCHANGE = 'documents';
export const DLX = 'documents.dlx';
export const QUEUE = 'documents.process';
export const DLQ = 'documents.dlq';
export const PROCESS_KEY = 'process';
export const DELIVERY_LIMIT = 3;

/** Retry queues are bound to the work exchange under their own routing key, so
 *  the publisher addresses them like any other message: publish('retry.1s', ...). */
export const RETRY_QUEUES = [
  { queue: 'documents.retry.1s', routingKey: 'retry.1s', ttlMs: 1_000 },
  { queue: 'documents.retry.3s', routingKey: 'retry.3s', ttlMs: 3_000 },
] as const;

/** At-least-once dead-lettering: the source queue keeps the message until the
 *  dead-letter target has confirmed it. Requires x-overflow=reject-publish. */
const SAFE_DEAD_LETTERING = {
  'x-dead-letter-strategy': 'at-least-once',
  'x-overflow': 'reject-publish',
};

/**
 * Declares the whole topology. Every call is idempotent (assert* is a no-op when
 * the entity already exists with the same arguments). Runs as the setup function
 * of every channel, so it runs on startup and again after every reconnect.
 */
export async function assertTopology(ch: Channel): Promise<void> {
  await ch.assertExchange(EXCHANGE, 'direct', { durable: true });
  await ch.assertExchange(DLX, 'direct', { durable: true });

  await ch.assertQueue(DLQ, { durable: true, arguments: { 'x-queue-type': 'quorum' } });
  await ch.bindQueue(DLQ, DLX, PROCESS_KEY);

  await ch.assertQueue(QUEUE, {
    durable: true,
    arguments: {
      'x-queue-type': 'quorum',
      'x-delivery-limit': DELIVERY_LIMIT,
      'x-dead-letter-exchange': DLX,
      'x-dead-letter-routing-key': PROCESS_KEY,
      ...SAFE_DEAD_LETTERING,
    },
  });
  await ch.bindQueue(QUEUE, EXCHANGE, PROCESS_KEY);

  for (const r of RETRY_QUEUES) {
    await ch.assertQueue(r.queue, {
      durable: true,
      arguments: {
        'x-queue-type': 'quorum',
        'x-message-ttl': r.ttlMs,
        'x-dead-letter-exchange': EXCHANGE,
        'x-dead-letter-routing-key': PROCESS_KEY,
        ...SAFE_DEAD_LETTERING,
      },
    });
    await ch.bindQueue(r.queue, EXCHANGE, r.routingKey);
  }
}
