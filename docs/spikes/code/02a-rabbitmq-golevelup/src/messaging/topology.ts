import { MessageHandlerErrorBehavior, RabbitMQConfig } from '@golevelup/nestjs-rabbitmq';

export const EXCHANGE = 'documents';
export const DLX = 'documents.dlx';
export const PROCESS_QUEUE = 'documents.process';
export const PROCESS_ROUTING_KEY = 'process';
export const DLQ = 'documents.dlq';
export const CONSUMER_CHANNEL = 'documents-consumer';
export const DELIVERY_LIMIT = 3;

// Retry queues are addressed through the SAME `documents` exchange with routing key
// `retry.<delay>`, so the publisher signature stays publish(routingKey, ...).
export const RETRY_DELAYS_MS = { '1s': 1000, '3s': 3000 } as const;
export type RetryDelay = keyof typeof RETRY_DELAYS_MS;
export const retryRoutingKey = (d: RetryDelay) => `retry.${d}`;
export const retryQueue = (d: RetryDelay) => `documents.retry.${d}`;

const QUORUM = { 'x-queue-type': 'quorum' };
// At-least-once dead-lettering (quorum only) requires x-overflow=reject-publish;
// otherwise RabbitMQ silently falls back to at-most-once.
const AT_LEAST_ONCE_DLX = { 'x-dead-letter-strategy': 'at-least-once', 'x-overflow': 'reject-publish' };

/**
 * Topology is declared by the library on (re)connect of the default channel
 * (AmqpConnection.setupInitChannel -> assertExchange/assertQueue/bindQueue). Idempotent.
 */
export function rabbitConfig(uri: string, opts: { consume: boolean }): RabbitMQConfig {
  return {
    uri,
    registerHandlers: opts.consume, // false => publisher-only process (e.g. outbox relay)
    enableDirectReplyTo: false, // no RPC; avoid an extra consumer on the default channel
    connectionInitOptions: { wait: true, timeout: 10_000, reject: true },
    // amqp-connection-manager: reconnect 1s after a drop; heartbeat detects dead TCP.
    connectionManagerOptions: { heartbeatIntervalInSeconds: 5, reconnectTimeInSeconds: 1 },
    // Dedicated consumer channel with prefetch 2. Default channel = topology + publishing.
    channels: { [CONSUMER_CHANNEL]: { prefetchCount: 2 } },
    defaultSubscribeErrorBehavior: MessageHandlerErrorBehavior.REQUEUE,
    exchanges: [
      { name: EXCHANGE, type: 'direct', options: { durable: true } },
      { name: DLX, type: 'fanout', options: { durable: true } },
    ],
    queues: [
      { name: DLQ, exchange: DLX, routingKey: '', options: { durable: true, arguments: { ...QUORUM } } },
      {
        name: PROCESS_QUEUE,
        exchange: EXCHANGE,
        routingKey: PROCESS_ROUTING_KEY,
        options: {
          durable: true,
          arguments: { ...QUORUM, 'x-delivery-limit': DELIVERY_LIMIT, 'x-dead-letter-exchange': DLX, ...AT_LEAST_ONCE_DLX },
        },
      },
      ...(Object.keys(RETRY_DELAYS_MS) as RetryDelay[]).map((d) => ({
        name: retryQueue(d),
        exchange: EXCHANGE,
        routingKey: retryRoutingKey(d),
        options: {
          durable: true,
          arguments: {
            ...QUORUM,
            'x-message-ttl': RETRY_DELAYS_MS[d],
            'x-dead-letter-exchange': EXCHANGE,
            'x-dead-letter-routing-key': PROCESS_ROUTING_KEY,
            ...AT_LEAST_ONCE_DLX,
          },
        },
      })),
    ],
  };
}
