import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { CqrsModule } from '@nestjs/cqrs';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { ProcessDocumentHandler } from '../documents/application/commands/process-document';
import { RequeueDocumentHandler } from '../documents/application/commands/requeue-document';
import { SubmitDocumentHandler } from '../documents/application/commands/submit-document';
import { queryHandlers } from '../documents/application/queries/document-queries';
import { OutboxRelay } from '../documents/application/relay/outbox-relay';
import { StuckDocumentSweeper } from '../documents/application/sweeper/stuck-document-sweeper';
import { DocumentsController } from '../documents/adapters/inbound/http/documents.controller';
import { HealthController } from '../documents/adapters/inbound/http/health.controller';
import { InMemoryDocumentConsumer } from '../documents/adapters/inbound/messaging/in-memory-consumer';
import { ProcessMessageDispatcher } from '../documents/adapters/inbound/messaging/process-message-dispatcher';
import { RelayLoop } from '../documents/adapters/inbound/messaging/relay-loop';
import { SweeperLoop } from '../documents/adapters/inbound/scheduling/sweeper-loop';
import {
  DEFAULT_SWEEPER_SETTINGS,
  SWEEPER_SETTINGS,
  type SweeperSettings,
} from '../documents/adapters/inbound/scheduling/sweeper-settings';
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

export interface WorkerOptions {
  logging?: LoggingOptions;
  /** How often to look for stuck documents, and when a document counts as stuck (ADR 0014). */
  sweeper?: SweeperSettings;
}

/**
 * Worker process: consumes messages, processes documents, runs the outbox relay and sweeps for
 * stuck documents. `consumers` is the inbound messaging adapter: the in-memory broker's (walking
 * skeleton) or RabbitMQ's.
 */
@Module({})
export class WorkerModule {
  static register(
    adapters: Provider[],
    consumers: Provider[] = [InMemoryDocumentConsumer, ProcessMessageDispatcher],
    options: WorkerOptions = {},
  ): DynamicModule {
    return {
      module: WorkerModule,
      imports: [
        CqrsModule.forRoot(),
        AdaptersModule.register(adapters),
        LoggerModule.forRoot(loggerParams(options.logging ?? { level: 'info' })),
      ],
      providers: [
        ProcessDocumentHandler,
        RequeueDocumentHandler,
        OutboxRelay,
        RelayLoop,
        StuckDocumentSweeper,
        SweeperLoop,
        { provide: SWEEPER_SETTINGS, useValue: options.sweeper ?? DEFAULT_SWEEPER_SETTINGS },
        ...consumers,
      ],
    };
  }
}
