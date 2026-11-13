import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { type Channel, connect } from 'amqplib';
import { Client } from 'pg';
import { expect } from 'vitest';
import type { HistoryEntryDto } from '../../../src/documents/adapters/inbound/http/document.dto';
import type { redriveSummary } from '../../../src/documents/adapters/inbound/messaging/dlq-redrive';
import type { RequeueReason } from '../../../src/documents/domain/document-events';
import { peppolFixture } from '../../fixtures/peppol';
import type { Api } from '../../e2e/support/stack';

/**
 * Helpers for the chaos tests (G10), on top of the e2e helpers (`../../e2e/support/stack`). The
 * API and the IdP are only used over HTTPS through the edge, like in the e2e tests. To set up and
 * inspect a failure, the tests also talk to the broker and the database directly on their
 * published ports: purge a queue, read a queue's depth, publish a poison message, count unpublished
 * outbox rows. Nothing here sleeps for a fixed time: every wait polls a condition until a deadline.
 */
export const infra = {
  amqpUrl: process.env.CHAOS_AMQP_URL ?? 'amqp://xip:xip@localhost:5672',
  databaseUrl: process.env.CHAOS_DATABASE_URL ?? 'postgresql://xip:xip@localhost:5432/xip',
  queues: { process: 'documents.process', dlq: 'documents.dlq' },
};

const repoRoot = path.resolve(__dirname, '../../../../..');
const run = promisify(execFile);

/** `docker compose <args>` for the full stack; returns stdout. */
export async function compose(...args: string[]): Promise<string> {
  const { stdout } = await run('docker', ['compose', '--profile', 'full', ...args], {
    cwd: repoRoot,
  });
  return stdout;
}

/** Interval between two polls; never used as "wait long enough for X to happen". */
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `probe` until it returns something other than undefined or false, or fails at the deadline. */
export async function waitUntil<T>(
  what: string,
  probe: () => Promise<T | undefined | false>,
  timeoutMs: number,
  intervalMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline)
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await pause(intervalMs);
  }
}

/** Runs `use` on a fresh channel and closes the connection, so a broker kill leaves nothing open. */
async function withChannel<T>(use: (channel: Channel) => Promise<T>): Promise<T> {
  const connection = await connect(infra.amqpUrl);
  try {
    return await use(await connection.createChannel());
  } finally {
    await connection.close().catch(() => undefined);
  }
}

export const broker = {
  /** Ready messages in a queue (taken but unacked ones do not count). */
  depth: (queue: string): Promise<number> =>
    withChannel(async (channel) => (await channel.checkQueue(queue)).messageCount),

  purge: (queue: string): Promise<number> =>
    withChannel(async (channel) => (await channel.purgeQueue(queue)).messageCount),

  /** Publishes straight to a queue (default exchange), with a publisher confirm. */
  async publishTo(queue: string, body: string, messageId: string): Promise<void> {
    const connection = await connect(infra.amqpUrl);
    try {
      const channel = await connection.createConfirmChannel();
      channel.sendToQueue(queue, Buffer.from(body), { messageId, persistent: true });
      await channel.waitForConfirms();
    } finally {
      await connection.close().catch(() => undefined);
    }
  },
};

export const database = {
  /** Outbox rows for these documents that the relay has not published yet. */
  async unpublishedOutboxRows(documentIds: string[]): Promise<number> {
    const client = new Client({ connectionString: infra.databaseUrl });
    await client.connect();
    try {
      const { rows } = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM outbox
          WHERE published_at IS NULL AND payload->>'documentId' = ANY($1::text[])`,
        [documentIds],
      );
      return rows[0]!.count;
    } finally {
      await client.end();
    }
  },
};

export type RedriveSummary = ReturnType<typeof redriveSummary>;

/**
 * `xip redrive [args]` as an operator runs it: a one-shot container from the worker's image, on
 * the stack's network (`docker compose run --rm`). Returns the exit code and the JSON summary.
 */
export async function redrive(
  ...args: string[]
): Promise<{ exitCode: number; summary: RedriveSummary }> {
  const command = ['compose', '--profile', 'full', 'run', '--rm', '--no-deps', '-T', 'worker'];
  try {
    const { stdout } = await run('docker', [...command, 'redrive', ...args], { cwd: repoRoot });
    return { exitCode: 0, summary: JSON.parse(stdout) as RedriveSummary };
  } catch (error) {
    const { code, stdout } = error as { code?: unknown; stdout?: string };
    if (typeof code !== 'number' || !stdout?.trim()) throw error;
    return { exitCode: code, summary: JSON.parse(stdout) as RedriveSummary };
  }
}

/**
 * Puts the stack back as the suite expects it, whatever a scenario left behind: nothing paused,
 * Postgres, RabbitMQ and the worker running, and an empty DLQ. Called after every scenario.
 */
export async function restoreStack(): Promise<void> {
  const paused = (await compose('ps', '--status', 'paused', '--services')).trim();
  if (paused) await compose('unpause', ...paused.split('\n'));
  await compose('up', '-d', '--wait', '--no-deps', 'postgres', 'rabbitmq', 'worker');
  await broker.purge(infra.queues.dlq);
}

const terminal = new Set(['DocumentProcessed', 'DocumentProcessingFailed']);

/**
 * The exactly-once invariants on a document's history, however often its messages were delivered,
 * lost, dead-lettered or requeued: gapless versions; attempts started once each, numbered 1, 2, …
 * up to the document's attempt count; every attempt ended at most once; and exactly one terminal
 * event, as the last entry. Returns the history for further assertions.
 */
export async function expectExactlyOnce(api: Api, documentId: string): Promise<HistoryEntryDto[]> {
  const document = await api.document(documentId);
  const history = await api.history(documentId);
  const attemptsOf = (type: string) =>
    history.filter((entry) => entry.type === type).map((entry) => entry.event.attempt as number);

  expect(history.map((entry) => entry.version)).toEqual(history.map((_, i) => i + 1));
  const started = attemptsOf('ProcessingStarted');
  expect(started, 'one ProcessingStarted per attempt').toEqual(
    Array.from({ length: document.attempts }, (_, i) => i + 1),
  );
  const failed = attemptsOf('ProcessingAttemptFailed');
  expect(failed, 'every attempt ended at most once').toEqual([...new Set(failed)]);
  expect(
    history.filter((entry) => terminal.has(entry.type)).map((entry) => entry.type),
  ).toHaveLength(1);
  expect(terminal.has(history.at(-1)!.type), 'the terminal event is the last').toBe(true);
  return history;
}

/** The requeues in a history: who sent the document again, and for which attempt. */
export function requeues(
  history: HistoryEntryDto[],
): Array<{ reason: RequeueReason; attempt: number }> {
  return history
    .filter((entry) => entry.type === 'ProcessingRequeued')
    .map((entry) => ({
      reason: entry.event.reason as RequeueReason,
      attempt: entry.event.attempt as number,
    }));
}

/**
 * The 300-line invoice, made unique. Its Schematron run takes long enough that an attempt is
 * still in progress when the test sees its ProcessingStarted, so the worker can be killed mid-attempt.
 */
export function largeInvoice(): Buffer {
  const xml = peppolFixture('large-300-lines')
    .toString('utf8')
    .replace(/<cbc:ID>INV-2026-0300<\/cbc:ID>/, `<cbc:ID>CHAOS-${randomUUID()}</cbc:ID>`);
  return Buffer.from(xml, 'utf8');
}
