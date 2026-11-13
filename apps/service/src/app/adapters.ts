import type { Provider } from '@nestjs/common';
import { z } from 'zod';
import {
  BlobStore,
  BusinessRuleValidator,
  Clock,
  DocumentViews,
  EventStore,
  IdempotencyRegistry,
  IdGenerator,
  InvoiceMapper,
  MessagePublisher,
  Outbox,
  StructureValidator,
  UnitOfWork,
  VatNumberVerifier,
} from '../documents/application/ports';
import { InMemoryBroker } from '../documents/adapters/outbound/in-memory/in-memory-broker';
import { InMemoryDatabase } from '../documents/adapters/outbound/in-memory/in-memory-database';
import {
  InMemoryBlobStore,
  InMemoryDocumentViews,
  InMemoryEventStore,
  InMemoryIdempotencyRegistry,
  InMemoryOutbox,
  InMemoryUnitOfWork,
} from '../documents/adapters/outbound/in-memory/in-memory-persistence';
import {
  ScriptedVatNumberVerifier,
  StubBusinessRuleValidator,
  StubInvoiceMapper,
  StubStructureValidator,
} from '../documents/adapters/outbound/in-memory/stub-validation';
import { PrismaBlobReferences } from '../documents/adapters/outbound/postgres/prisma-blob-references';
import { postgresProviders } from '../documents/adapters/outbound/postgres/postgres-providers';
import { AmqpConnection } from '../documents/adapters/outbound/rabbitmq/amqp-connection';
import { loadRabbitMqConfig } from '../documents/adapters/outbound/rabbitmq/rabbitmq-config';
import { rabbitMqProviders } from '../documents/adapters/outbound/rabbitmq/rabbitmq-providers';
import { BlobReferences } from '../documents/adapters/outbound/s3/blob-references';
import { ObjectStore } from '../documents/adapters/outbound/s3/object-store';
import {
  OrphanObjectCollector,
  OrphanSweepLoop,
} from '../documents/adapters/outbound/s3/orphan-objects';
import { S3BlobStore } from '../documents/adapters/outbound/s3/s3-blob-store';
import {
  loadOrphanSweepSettings,
  loadS3Config,
  ORPHAN_SWEEP_SETTINGS,
} from '../documents/adapters/outbound/s3/s3-config';
import { S3ObjectStore } from '../documents/adapters/outbound/s3/s3-object-store';
import { RandomIdGenerator, SystemClock } from '../documents/adapters/outbound/system/system';
import {
  schematronTimeoutMs,
  validationProviders,
} from '../documents/adapters/outbound/validation/validation-providers';
import { InMemoryDocumentConsumer } from '../documents/adapters/inbound/messaging/in-memory-consumer';
import { DeadLetterSource } from '../documents/adapters/inbound/messaging/dlq-redrive';
import { ProcessMessageDispatcher } from '../documents/adapters/inbound/messaging/process-message-dispatcher';
import { RabbitMqDeadLetterSource } from '../documents/adapters/inbound/messaging/rabbitmq-dead-letter-source';
import { messagingConsumers } from '../documents/adapters/inbound/messaging/rabbitmq-document-consumer';
import {
  loadSweeperSettings,
  type SweeperSettings,
} from '../documents/adapters/inbound/scheduling/sweeper-settings';
import type { AppConfig } from '../shared/config';

/**
 * Composition root: binds every port to an adapter. `in-memory` is the walking skeleton
 * (no infrastructure needed, API and worker in one process); `real` binds Postgres, RabbitMQ,
 * libxml2/SaxonJS and the VIES fake for the two processes of a deployment.
 */
export interface InMemoryAdapters {
  db: InMemoryDatabase;
  broker: InMemoryBroker;
  structure: StubStructureValidator;
  mapper: StubInvoiceMapper;
  rules: StubBusinessRuleValidator;
  vat: ScriptedVatNumberVerifier;
}

export function createInMemoryAdapters(options: { retryDelayMs?: number } = {}): InMemoryAdapters {
  return {
    db: new InMemoryDatabase(),
    broker: new InMemoryBroker({ retryDelayMs: options.retryDelayMs ?? 10 }),
    structure: new StubStructureValidator(),
    mapper: new StubInvoiceMapper(),
    rules: new StubBusinessRuleValidator(),
    vat: new ScriptedVatNumberVerifier(),
  };
}

export function inMemoryProviders(adapters: InMemoryAdapters): Provider[] {
  const { db } = adapters;
  return [
    { provide: UnitOfWork, useValue: new InMemoryUnitOfWork(db) },
    { provide: EventStore, useValue: new InMemoryEventStore(db) },
    { provide: DocumentViews, useValue: new InMemoryDocumentViews(db) },
    { provide: BlobStore, useValue: new InMemoryBlobStore(db) },
    { provide: Outbox, useValue: new InMemoryOutbox(db) },
    { provide: IdempotencyRegistry, useValue: new InMemoryIdempotencyRegistry(db) },
    { provide: MessagePublisher, useValue: adapters.broker },
    { provide: StructureValidator, useValue: adapters.structure },
    { provide: InvoiceMapper, useValue: adapters.mapper },
    { provide: BusinessRuleValidator, useValue: adapters.rules },
    { provide: VatNumberVerifier, useValue: adapters.vat },
    { provide: Clock, useClass: SystemClock },
    { provide: IdGenerator, useClass: RandomIdGenerator },
  ];
}

/** The process the providers are for. Only the worker talks to RabbitMQ (the relay publishes). */
export type ProcessRole = 'api' | 'worker';

/**
 * The real adapters. Missing settings are a startup error, not a failure on the first request:
 * both processes need DATABASE_URL, the worker also AMQP_URL, and BLOB_STORE=s3 needs S3_*. The
 * validation adapters and the VIES fake read their own settings (SCHEMATRON_*, VIES_*) from `env`.
 */
export function realProviders(
  config: AppConfig,
  role: ProcessRole,
  env: NodeJS.ProcessEnv = process.env,
): Provider[] {
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is required when ADAPTERS=real');
  if (role === 'worker' && !config.AMQP_URL) {
    throw new Error('AMQP_URL is required for the worker when ADAPTERS=real');
  }
  return [
    ...persistenceProviders(config.DATABASE_URL, role, env),
    ...(role === 'worker' ? rabbitMqProviders(loadRabbitMqConfig(env)) : []),
    ...validationProviders(env),
    { provide: Clock, useClass: SystemClock },
    { provide: IdGenerator, useClass: RandomIdGenerator },
  ];
}

const blobStoreSchema = z.object({ BLOB_STORE: z.enum(['postgres', 's3']).default('postgres') });

/**
 * Postgres for everything, and for the documents' bytes either the blobs table
 * (BLOB_STORE=postgres, the default) or an S3 bucket with only the reference in the blobs table
 * (BLOB_STORE=s3, ADR 0016). With S3 the worker also deletes orphaned objects.
 */
export function persistenceProviders(
  databaseUrl: string,
  role: ProcessRole,
  env: NodeJS.ProcessEnv,
): Provider[] {
  const postgres = postgresProviders(databaseUrl);
  if (blobStoreSchema.parse(env).BLOB_STORE === 'postgres') return postgres;
  const s3 = loadS3Config(env);
  return [
    ...postgres.filter((provider) => (provider as { provide?: unknown }).provide !== BlobStore),
    { provide: ObjectStore, useFactory: () => new S3ObjectStore(s3) },
    { provide: BlobReferences, useClass: PrismaBlobReferences },
    { provide: BlobStore, useClass: S3BlobStore },
    ...(role === 'worker'
      ? [
          OrphanObjectCollector,
          OrphanSweepLoop,
          { provide: ORPHAN_SWEEP_SETTINGS, useValue: loadOrphanSweepSettings(env) },
        ]
      : []),
  ];
}

export function adapterProviders(config: AppConfig, role: ProcessRole): Provider[] {
  return config.ADAPTERS === 'in-memory'
    ? inMemoryProviders(createInMemoryAdapters())
    : realProviders(config, role);
}

/** The worker's inbound adapter: what feeds messages to ProcessDocument. */
export function consumerProviders(config: AppConfig): Provider[] {
  return config.ADAPTERS === 'in-memory'
    ? [InMemoryDocumentConsumer, ProcessMessageDispatcher]
    : messagingConsumers;
}

/**
 * The worker's sweeper settings (SWEEPER_*). With the real adapters, a document may legitimately
 * stay unchanged for the longest retry delay plus the Schematron timeout, so the threshold must be
 * longer; a lower one is a startup error.
 */
export function sweeperSettings(
  config: AppConfig,
  env: NodeJS.ProcessEnv = process.env,
): SweeperSettings {
  if (config.ADAPTERS === 'in-memory') return loadSweeperSettings(env);
  const longestRetryDelayMs = Math.max(...loadRabbitMqConfig(env).retryDelaysMs);
  return loadSweeperSettings(env, longestRetryDelayMs + schematronTimeoutMs(env));
}

/**
 * `xip redrive`, a one-shot process next to the workers: Postgres for the requeue's unit of work
 * and RabbitMQ for the dead-letter queue. It never publishes; the workers' relay does.
 */
export function redriveProviders(
  config: AppConfig,
  env: NodeJS.ProcessEnv = process.env,
): Provider[] {
  if (config.ADAPTERS !== 'real') {
    throw new Error('xip redrive needs ADAPTERS=real: the dead-letter queue is in RabbitMQ');
  }
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is required for xip redrive');
  if (!config.AMQP_URL) throw new Error('AMQP_URL is required for xip redrive');
  const rabbitMq = loadRabbitMqConfig(env);
  return [
    ...postgresProviders(config.DATABASE_URL),
    { provide: AmqpConnection, useFactory: () => new AmqpConnection(rabbitMq) },
    {
      provide: DeadLetterSource,
      useFactory: (connection: AmqpConnection) => new RabbitMqDeadLetterSource(connection),
      inject: [AmqpConnection],
    },
    { provide: Clock, useClass: SystemClock },
    { provide: IdGenerator, useClass: RandomIdGenerator },
  ];
}
