import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import type { Transaction } from '../../../application/ports';
import { Prisma, PrismaClient } from '../../../../generated/prisma/client';

const SCHEMA_NAME = /^[a-z_][a-z0-9_]*$/i;

/**
 * The one PrismaClient of the process (ADR 0009), on top of node-postgres via
 * `@prisma/adapter-pg`. Connects on bootstrap and disconnects on shutdown.
 *
 * An optional `?schema=` in the URL is honoured the way `prisma migrate deploy` honours it:
 * Prisma's own queries are qualified with it and raw SQL finds it through `search_path`.
 * The contract tests use this to run in a throwaway schema.
 */
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(databaseUrl: string) {
    const url = new URL(databaseUrl);
    const schema = url.searchParams.get('schema') ?? undefined;
    url.searchParams.delete('schema');
    if (schema !== undefined && !SCHEMA_NAME.test(schema)) {
      throw new Error(`Invalid schema name in DATABASE_URL: ${schema}`);
    }
    super({
      adapter: new PrismaPg(
        {
          connectionString: url.toString(),
          ...(schema ? { options: `-c search_path=${schema}` } : {}),
        },
        schema ? { schema } : undefined,
      ),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

/** The unit of work hands out the Prisma transaction client as the opaque Transaction. */
export const asTransaction = (client: Prisma.TransactionClient): Transaction =>
  client as unknown as Transaction;

/** Every adapter casts the Transaction back to the Prisma transaction client it really is. */
export const prismaTx = (tx: Transaction): Prisma.TransactionClient =>
  tx as unknown as Prisma.TransactionClient;

/** Unique-constraint violation: a concurrency conflict or an idempotency hit. */
export const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

/** Our JSON values (events, metadata, payloads) are plain data; Prisma's input type cannot see that. */
export const toJson = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;
