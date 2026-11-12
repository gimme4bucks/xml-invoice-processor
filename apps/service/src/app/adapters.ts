import type { Provider } from '@nestjs/common';
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
import { RandomIdGenerator, SystemClock } from '../documents/adapters/outbound/system/system';
import type { AppConfig } from '../shared/config';

/**
 * Composition root: binds every port to an adapter. `in-memory` is the walking skeleton
 * (no infrastructure needed); `real` binds Postgres, RabbitMQ, libxml2/SaxonJS and the VIES
 * fake, and is completed in work package G07 as the real adapters land.
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

export function realProviders(_config: AppConfig): Provider[] {
  // G07 replaces this with the Postgres, RabbitMQ, validation and VIES adapters.
  throw new Error('ADAPTERS=real is not wired yet; use ADAPTERS=in-memory (walking skeleton)');
}

export function adapterProviders(config: AppConfig, inMemory?: InMemoryAdapters): Provider[] {
  return config.ADAPTERS === 'in-memory'
    ? inMemoryProviders(inMemory ?? createInMemoryAdapters())
    : realProviders(config);
}
