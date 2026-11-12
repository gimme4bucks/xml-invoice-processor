import { DynamicModule, Module } from '@nestjs/common';
import { AMQP_URL, AmqpConnection } from './amqp-connection';
import { ConfirmPublisher } from './confirm-publisher';
import { DocumentConsumer } from './document-consumer';

@Module({})
export class AmqpModule {
  static forRoot(url: string): DynamicModule {
    return {
      module: AmqpModule,
      providers: [{ provide: AMQP_URL, useValue: url }, AmqpConnection, ConfirmPublisher, DocumentConsumer],
      exports: [ConfirmPublisher, DocumentConsumer],
    };
  }
}
