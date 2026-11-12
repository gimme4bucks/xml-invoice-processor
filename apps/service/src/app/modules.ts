import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { CqrsModule } from '@nestjs/cqrs';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { ProcessDocumentHandler } from '../documents/application/commands/process-document';
import { SubmitDocumentHandler } from '../documents/application/commands/submit-document';
import { queryHandlers } from '../documents/application/queries/document-queries';
import { OutboxRelay } from '../documents/application/relay/outbox-relay';
import { DocumentsController } from '../documents/adapters/inbound/http/documents.controller';
import { HealthController } from '../documents/adapters/inbound/http/health.controller';
import { InMemoryDocumentConsumer } from '../documents/adapters/inbound/messaging/in-memory-consumer';
import { RelayLoop } from '../documents/adapters/inbound/messaging/relay-loop';
import { AUTH_OPTIONS, type AuthOptions } from '../shared/auth/auth-options';
import { JwtAuthGuard } from '../shared/auth/jwt-auth.guard';
import { loggerParams, type LoggingOptions } from '../shared/logging/logging';
import { ProblemDetailsFilter } from '../shared/problem-details/problem-details.filter';
import {
  OrganisationThrottlerGuard,
  type RateLimitOptions,
  throttlerOptions,
} from '../shared/rate-limit/organisation-throttler.guard';

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

export interface ApiOptions {
  /** Token verification. main-api.ts builds it from AUTH_*; without it every request gets 503. */
  auth?: AuthOptions;
  rateLimit?: RateLimitOptions;
  logging?: LoggingOptions;
}

/**
 * API process: intake (SubmitDocument) and queries over HTTP. Needs Postgres, not RabbitMQ.
 * Request pipeline: pino logger (correlation id) → JwtAuthGuard (401/403) → rate limit per
 * organisation (429) → validation pipes (400) → controller; every error → Problem Details.
 */
@Module({})
export class ApiModule {
  static register(adapters: Provider[], options: ApiOptions = {}): DynamicModule {
    return {
      module: ApiModule,
      imports: [
        CqrsModule.forRoot(),
        AdaptersModule.register(adapters),
        LoggerModule.forRoot(loggerParams(options.logging ?? { level: 'info' })),
        ThrottlerModule.forRoot(
          throttlerOptions(options.rateLimit ?? { limit: 120, windowMs: 60_000 }),
        ),
      ],
      controllers: [HealthController, DocumentsController],
      providers: [
        SubmitDocumentHandler,
        ...queryHandlers,
        ...(options.auth ? [{ provide: AUTH_OPTIONS, useValue: options.auth }] : []),
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
        // Global guards run in this order: the rate limit needs the authenticated organisation.
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: OrganisationThrottlerGuard },
      ],
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
