import type { OnModuleDestroy } from '@nestjs/common';
import { AmqpConnection } from '../../outbound/rabbitmq/amqp-connection';
import { type DeadLetter, DeadLetterSource } from './dlq-redrive';

export class RabbitMqDeadLetterSource extends DeadLetterSource implements OnModuleDestroy {
  constructor(private readonly connection: AmqpConnection) {
    super();
  }

  count(): Promise<number> {
    throw new Error('RabbitMqDeadLetterSource is not implemented yet');
  }

  next(): Promise<DeadLetter | undefined> {
    throw new Error('RabbitMqDeadLetterSource is not implemented yet');
  }

  async onModuleDestroy(): Promise<void> {}
}
