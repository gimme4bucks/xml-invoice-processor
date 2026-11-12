import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConcurrencyError, PersistenceUnavailableError } from '../../../application/ports';
import { Prisma } from '../../../../generated/prisma/client';
import { guardUnavailable } from './prisma.service';

const known = (code: string) =>
  new Prisma.PrismaClientKnownRequestError(`failed (${code})`, { code, clientVersion: '7' });
const socketError = (code: string) =>
  Object.assign(new Error(`connect ${code} 10.0.0.1:5432`), { code, syscall: 'connect' });

describe('guardUnavailable (Postgres outage → PersistenceUnavailableError)', () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    ['cannot reach the server', known('P1001')],
    ['transaction did not start in time (maxWait)', known('P2028')],
    ['pool timeout', known('P2024')],
    ['a refused connection', socketError('ECONNREFUSED')],
    ['an unknown host (container gone)', socketError('ENOTFOUND')],
    [
      'a driver error wrapped by Prisma',
      new Error('wrapped', { cause: { kind: 'ConnectionClosed' } }),
    ],
    ['the pg connect timeout', new Error('Connection terminated due to connection timeout')],
    ['the pg pool timeout', new Error('timeout exceeded when trying to connect')],
  ])('translates %s', async (_, error) => {
    await expect(guardUnavailable(() => Promise.reject(error))).rejects.toBeInstanceOf(
      PersistenceUnavailableError,
    );
  });

  it('keeps the reason log-safe: an error code, not the driver message', async () => {
    await expect(
      guardUnavailable(() => Promise.reject(socketError('ECONNREFUSED'))),
    ).rejects.toThrow('Persistence unavailable: ECONNREFUSED');
  });

  it.each([
    ['a unique violation', known('P2002')],
    ['an error of the application', new ConcurrencyError('stream', 1)],
    ['any other error', new Error('boom')],
  ])('passes %s through unchanged', async (_, error) => {
    await expect(guardUnavailable(() => Promise.reject(error))).rejects.toBe(error);
  });

  it('stops waiting for a database that does not answer at all', async () => {
    vi.useFakeTimers();
    const hanging = guardUnavailable(() => new Promise<never>(() => undefined));
    const outcome = expect(hanging).rejects.toThrow(/no answer within \d+ ms/);
    await vi.advanceTimersByTimeAsync(10_000);
    await outcome;
  });

  it('returns the result of a call that answers', async () => {
    await expect(guardUnavailable(() => Promise.resolve(42))).resolves.toBe(42);
  });
});
