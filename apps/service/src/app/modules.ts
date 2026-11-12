import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { ProcessDocumentHandler } from '../documents/application/commands/process-document';
import { SubmitDocumentHandler } from '../documents/application/commands/submit-document';
import { queryHandlers } from '../documents/application/queries/document-queries';
import { OutboxRelay } from '../documents/application/relay/outbox-relay';
import { HealthController } from '../documents/adapters/inbound/http/health.controller';
import { InMemoryDocumentConsumer } from '../documents/adapters/inbound/messaging/in-memory-consumer';
import { RelayLoop } from '../documents/adapters/inbound/messaging/relay-loop';

/** Bundles the port bindings so both processes (and tests) can pass their own. */
@Module({})
class AdaptersModule {
  static register(providers: Provider[]): DynamicModule {
    return {
      module: AdaptersModule,
      global: true,
      providers,
      exports: providers.map((p) => (typeof p === 'function' ? p : p.provide)),
    };
  }
}

/** API process: intake (SubmitDocument) and queries. Needs Postgres, not RabbitMQ. */
@Module({})
export class ApiModule {
  static register(adapters: Provider[]): DynamicModule {
    return {
      module: ApiModule,
      imports: [CqrsModule.forRoot(), AdaptersModule.register(adapters)],
      controllers: [HealthController],
      providers: [SubmitDocumentHandler, ...queryHandlers],
    };
  }
}

/** Worker process: consumes messages, processes documents and runs the outbox relay. */
@Module({})
export class WorkerModule {
  static register(adapters: Provider[]): DynamicModule {
    return {
      module: WorkerModule,
      imports: [CqrsModule.forRoot(), AdaptersModule.register(adapters)],
      providers: [ProcessDocumentHandler, OutboxRelay, RelayLoop, InMemoryDocumentConsumer],
    };
  }
}
