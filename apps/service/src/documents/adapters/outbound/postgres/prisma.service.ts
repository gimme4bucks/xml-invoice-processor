import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PersistenceUnavailableError, type Transaction } from '../../../application/ports';
import { Prisma, PrismaClient } from '../../../../generated/prisma/client';

const SCHEMA_NAME = /^[a-z_][a-z0-9_]*$/i;

/**
 * Bounds on waiting for Postgres, so that an outage gives a quick 503 (API) or requeue (worker)
 * instead of a request that hangs until the database is back:
 * - a new connection, or a free slot in the pool, must be there within CONNECT_TIMEOUT_MS;
 * - an interactive transaction must have begun within `maxWait` and finish within `timeout`;
 * - no call keeps its caller waiting longer than DEADLINE_MS (a frozen server never answers).
 *
 * There is deliberately no pg `query_timeout`: when it fires on a transaction's ROLLBACK, pg
 * drops the ROLLBACK unsent while Prisma still returns the connection to the pool, so the next
 * transaction on that connection could commit the abandoned writes.
 */
const CONNECT_TIMEOUT_MS = 5_000;
const TRANSACTION_OPTIONS = { maxWait: 2_000, timeout: 5_000 };
const DEADLINE_MS = 10_000;

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
          connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
          ...(schema ? { options: `-c search_path=${schema}` } : {}),
        },
        schema ? { schema } : undefined,
      ),
      transactionOptions: TRANSACTION_OPTIONS,
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

/** Prisma error codes for "cannot reach / timed out / connection closed / pool or transaction timeout". */
const UNAVAILABLE_PRISMA_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028']);
/** Socket errors (node) and driver adapter error kinds that mean the database is not there. */
const UNAVAILABLE_CAUSES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'EPIPE',
  'DatabaseNotReachable',
  'ConnectionClosed',
  'SocketTimeout',
  'TooManyConnections',
]);
/** node-postgres reports its own timeouts and lost connections with these messages only. */
const UNAVAILABLE_PG_MESSAGE = /timeout exceeded when trying to connect|Connection terminated/;

/**
 * A short, log-safe reason (an error code, never a message with SQL or data) when `error` means
 * the database is unreachable or too slow; undefined for every other error.
 */
function unavailableReason(error: unknown): string | undefined {
  // Walk the cause chain: Prisma wraps driver errors, whose cause is a plain `{ kind }` object.
  let cause: unknown = error;
  for (let depth = 0; typeof cause === 'object' && cause !== null && depth < 5; depth++) {
    if (cause instanceof Prisma.PrismaClientKnownRequestError) {
      if (UNAVAILABLE_PRISMA_CODES.has(cause.code)) return cause.code;
    } else if (cause instanceof Prisma.PrismaClientInitializationError) {
      return cause.errorCode ?? 'initialization failed';
    } else {
      const { code, kind, message } = cause as {
        code?: unknown;
        kind?: unknown;
        message?: unknown;
      };
      for (const marker of [code, kind]) {
        if (typeof marker === 'string' && UNAVAILABLE_CAUSES.has(marker)) return marker;
      }
      if (typeof message === 'string' && UNAVAILABLE_PG_MESSAGE.test(message)) {
        return 'connection timeout or lost connection';
      }
    }
    cause = (cause as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Runs one database call with a deadline and translates "the database is not there" into the
 * port's PersistenceUnavailableError. Every other error passes through unchanged: constraint
 * violations, and the application's own errors thrown inside a unit of work.
 *
 * On the deadline we only stop waiting. An abandoned transaction is rolled back by Prisma's
 * timeout, or commits if it was already committing; the caller then retries with the same
 * Idempotency-Key (API) or redelivers the message (worker), and both paths are idempotent.
 */
export async function guardUnavailable<T>(call: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new PersistenceUnavailableError(`no answer within ${DEADLINE_MS} ms`)),
      DEADLINE_MS,
    );
  });
  try {
    return await Promise.race([call(), deadline]);
  } catch (error) {
    const reason = unavailableReason(error);
    throw reason === undefined ? error : new PersistenceUnavailableError(reason);
  } finally {
    clearTimeout(timer);
  }
}

/** Our JSON values (events, metadata, payloads) are plain data; Prisma's input type cannot see that. */
export const toJson = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;
