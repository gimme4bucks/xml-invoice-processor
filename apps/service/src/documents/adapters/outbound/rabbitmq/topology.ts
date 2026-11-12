import type { Channel } from 'amqplib';
import { RoutingKeys } from '../../../application/ports';
import type { RabbitMqConfig } from './rabbitmq-config';

/**
 * Deliveries of one message on the process queue before it is dead-lettered. Only a guard against
 * poison messages: broker restarts and worker crashes also count, so it is well above what a
 * healthy message needs. The processing retry count lives in the aggregate (ADR 0006).
 */
export const DELIVERY_LIMIT = 10;

export interface Topology {
  exchange: string;
  deadLetterExchange: string;
  processQueue: string;
  deadLetterQueue: string;
  retryQueues: ReadonlyArray<{ queue: string; routingKey: string; ttlMs: number }>;
}

export function topologyFor(config: Pick<RabbitMqConfig, 'prefix' | 'retryDelaysMs'>): Topology {
  const { prefix, retryDelaysMs } = config;
  return {
    exchange: `${prefix}documents`,
    deadLetterExchange: `${prefix}documents.dlx`,
    processQueue: `${prefix}documents.process`,
    deadLetterQueue: `${prefix}documents.dlq`,
    retryQueues: RoutingKeys.retry.map((routingKey, index) => {
      const ttlMs = retryDelaysMs[index];
      if (ttlMs === undefined) throw new Error(`No retry delay configured for ${routingKey}`);
      return { queue: `${prefix}documents.${routingKey}`, routingKey, ttlMs };
    }),
  };
}

/**
 * At-least-once dead-lettering: the source queue keeps a message until the dead-letter target
 * confirmed it. Without reject-publish, RabbitMQ silently falls back to at-most-once (spike 02b).
 */
const SAFE_DEAD_LETTERING = {
  'x-dead-letter-strategy': 'at-least-once',
  'x-overflow': 'reject-publish',
};

/**
 * Declares the whole topology. Idempotent, and run by every channel's setup, so on startup and
 * after every reconnect. Changing the arguments of an existing queue (for example a retry TTL)
 * makes the broker refuse the declaration (406); that needs a new prefix or a policy.
 *
 * - exchange `documents` (direct): `process` → `documents.process`, `retry.*` → the delay queues;
 * - `documents.process`: quorum, delivery limit, dead-letters to `documents.dlx` → `documents.dlq`;
 * - `documents.retry.*`: quorum with a TTL, dead-letter back to `documents` with key `process`.
 */
export async function assertTopology(channel: Channel, topology: Topology): Promise<void> {
  await channel.assertExchange(topology.exchange, 'direct', { durable: true });
  await channel.assertExchange(topology.deadLetterExchange, 'direct', { durable: true });

  await channel.assertQueue(topology.deadLetterQueue, {
    durable: true,
    arguments: { 'x-queue-type': 'quorum' },
  });
  await channel.bindQueue(
    topology.deadLetterQueue,
    topology.deadLetterExchange,
    RoutingKeys.process,
  );

  await channel.assertQueue(topology.processQueue, {
    durable: true,
    arguments: {
      'x-queue-type': 'quorum',
      'x-delivery-limit': DELIVERY_LIMIT,
      'x-dead-letter-exchange': topology.deadLetterExchange,
      'x-dead-letter-routing-key': RoutingKeys.process,
      ...SAFE_DEAD_LETTERING,
    },
  });
  await channel.bindQueue(topology.processQueue, topology.exchange, RoutingKeys.process);

  for (const retry of topology.retryQueues) {
    await channel.assertQueue(retry.queue, {
      durable: true,
      arguments: {
        'x-queue-type': 'quorum',
        'x-message-ttl': retry.ttlMs,
        'x-dead-letter-exchange': topology.exchange,
        'x-dead-letter-routing-key': RoutingKeys.process,
        ...SAFE_DEAD_LETTERING,
      },
    });
    await channel.bindQueue(retry.queue, topology.exchange, retry.routingKey);
  }
}
