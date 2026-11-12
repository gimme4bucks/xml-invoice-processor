import { DynamicModule, Module } from '@nestjs/common';
import { RabbitMQModule } from '@golevelup/nestjs-rabbitmq';
import { rabbitConfig } from './topology';
import { DocumentPublisher } from './publisher';
import { DOCUMENT_HANDLER, DocumentConsumer, DocumentHandler } from './consumer';

export interface WorkerOptions {
  uri: string;
  consume: boolean;
  handler?: DocumentHandler;
}

@Module({})
export class WorkerModule {
  static register(opts: WorkerOptions): DynamicModule {
    const noop: DocumentHandler = { handle: async () => undefined };
    return {
      module: WorkerModule,
      imports: [RabbitMQModule.forRoot(rabbitConfig(opts.uri, { consume: opts.consume }))],
      providers: [DocumentPublisher, DocumentConsumer, { provide: DOCUMENT_HANDLER, useValue: opts.handler ?? noop }],
      exports: [DocumentPublisher],
    };
  }
}
