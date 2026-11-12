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
});

/** Reads the RabbitMQ settings from the environment; throws when AMQP_URL is missing. */
export function loadRabbitMqConfig(env: NodeJS.ProcessEnv = process.env): RabbitMqConfig {
  const parsed = schema.parse(env);
  return {
    url: parsed.AMQP_URL,
    prefix: parsed.AMQP_PREFIX,
    prefetch: parsed.AMQP_PREFETCH,
    retryDelaysMs: parsed.RETRY_DELAYS_MS,
  };
}
