import type { Provider } from '@nestjs/common';
import { MessagePublisher } from '../../../application/ports';
import { AmqpConnection } from './amqp-connection';
import { loadRabbitMqConfig, type RabbitMqConfig } from './rabbitmq-config';
import { RabbitMqPublisher } from './rabbitmq-publisher';

/**
 * The shared AMQP connection and the MessagePublisher port, for the composition root. The worker
 * adds `messagingConsumers` (adapters/inbound/messaging) on top; the API needs neither.
 */
export function rabbitMqProviders(config: RabbitMqConfig = loadRabbitMqConfig()): Provider[] {
  return [
    { provide: AmqpConnection, useFactory: () => new AmqpConnection(config) },
    {
      provide: MessagePublisher,
      useFactory: (connection: AmqpConnection) => new RabbitMqPublisher(connection),
      inject: [AmqpConnection],
    },
  ];
}
