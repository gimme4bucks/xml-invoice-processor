import type { Provider } from '@nestjs/common';
import {
  BlobStore,
  DocumentViews,
  EventStore,
  IdempotencyRegistry,
  Outbox,
  UnitOfWork,
} from '../../../application/ports';
import {
  PrismaBlobStore,
  PrismaDocumentViews,
  PrismaEventStore,
  PrismaIdempotencyRegistry,
  PrismaOutbox,
  PrismaUnitOfWork,
} from './prisma-persistence';
import { PrismaService } from './prisma.service';

/**
 * Binds every persistence port to its Postgres adapter, plus the one PrismaService they share.
 * The composition root (G07) passes `config.DATABASE_URL`.
 */
export function postgresProviders(databaseUrl = process.env.DATABASE_URL): Provider[] {
  return [
    {
      provide: PrismaService,
      useFactory: () => {
        if (!databaseUrl) throw new Error('DATABASE_URL is required for the Postgres adapters');
        return new PrismaService(databaseUrl);
      },
    },
    { provide: UnitOfWork, useClass: PrismaUnitOfWork },
    { provide: EventStore, useClass: PrismaEventStore },
    { provide: DocumentViews, useClass: PrismaDocumentViews },
    { provide: BlobStore, useClass: PrismaBlobStore },
    { provide: Outbox, useClass: PrismaOutbox },
    { provide: IdempotencyRegistry, useClass: PrismaIdempotencyRegistry },
  ];
}
