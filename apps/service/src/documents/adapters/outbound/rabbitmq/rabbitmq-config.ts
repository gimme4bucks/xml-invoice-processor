import { z } from 'zod';
import { RoutingKeys } from '../../../application/ports';

/** Settings of the RabbitMQ adapters (publisher, consumer, topology). */
export interface RabbitMqConfig {
  url: string;
  /** Prepended to every exchange and queue name, so test runs stay isolated on a shared broker. */
  prefix: string;
  /** Unacked deliveries per consumer channel: how many documents one worker processes at once. */
  prefetch: number;
  /** TTL of each retry queue, in the order of `RoutingKeys.retry` (5 s, 30 s, 2 min by default). */
  retryDelaysMs: readonly number[];
  /**
   * Back-off before a failed delivery is requeued: `base * 2^deliveryCount`, capped at `max`.
   * Keeps an infrastructure outage (e.g. Postgres down) from burning the delivery limit in
   * milliseconds and dead-lettering healthy messages.
   */
  requeueDelayMs: { base: number; max: number };
}

/** Delay before requeueing a delivery that has already been delivered `deliveryCount` times. */
export function requeueDelay(
  deliveryCount: number,
  delay: RabbitMqConfig['requeueDelayMs'],
): number {
  const count = Number.isFinite(deliveryCount) ? Math.max(0, deliveryCount) : 0;
  return Math.min(delay.base * 2 ** count, delay.max);
}

const schema = z.object({
  AMQP_URL: z.string().min(1),
  AMQP_PREFIX: z.string().default(''),
  AMQP_PREFETCH: z.coerce.number().int().positive().default(4),
  RETRY_DELAYS_MS: z
    .string()
    .default('5000,30000,120000')
    .transform((value) => value.split(',').map(Number))
    .pipe(z.array(z.number().int().positive()).length(RoutingKeys.retry.length)),
  AMQP_REQUEUE_DELAY_BASE_MS: z.coerce.number().int().nonnegative().default(1_000),
  AMQP_REQUEUE_DELAY_MAX_MS: z.coerce.number().int().nonnegative().default(30_000),
});

/** Reads the RabbitMQ settings from the environment; throws when AMQP_URL is missing. */
export function loadRabbitMqConfig(env: NodeJS.ProcessEnv = process.env): RabbitMqConfig {
  const parsed = schema.parse(env);
  return {
    url: parsed.AMQP_URL,
    prefix: parsed.AMQP_PREFIX,
    prefetch: parsed.AMQP_PREFETCH,
    retryDelaysMs: parsed.RETRY_DELAYS_MS,
    requeueDelayMs: {
      base: parsed.AMQP_REQUEUE_DELAY_BASE_MS,
      max: parsed.AMQP_REQUEUE_DELAY_MAX_MS,
    },
  };
}
