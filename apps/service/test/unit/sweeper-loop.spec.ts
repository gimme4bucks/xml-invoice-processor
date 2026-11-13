import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import type { INestApplicationContext } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createInMemoryAdapters,
  type InMemoryAdapters,
  inMemoryProviders,
  sweeperSettings,
} from '../../src/app/adapters';
import { WorkerModule } from '../../src/app/modules';
import { SweeperLoop } from '../../src/documents/adapters/inbound/scheduling/sweeper-loop';
import { loadSweeperSettings } from '../../src/documents/adapters/inbound/scheduling/sweeper-settings';
import {
  SubmitDocumentCommand,
  SubmitDocumentHandler,
} from '../../src/documents/application/commands/submit-document';
import { DocumentViews, EventStore } from '../../src/documents/application/ports';
import { loadConfig } from '../../src/shared/config';

describe('sweeper settings', () => {
  it('defaults to production-like values: every minute, stuck after 15 minutes', () => {
    expect(loadSweeperSettings({})).toEqual({ intervalMs: 60_000, stuckAfterMs: 900_000 });
  });

  it('reads SWEEPER_INTERVAL_MS and SWEEPER_STUCK_AFTER_MS', () => {
    expect(
      loadSweeperSettings({ SWEEPER_INTERVAL_MS: '10000', SWEEPER_STUCK_AFTER_MS: '90000' }),
    ).toEqual({ intervalMs: 10_000, stuckAfterMs: 90_000 });
  });

  it('refuses a threshold that does not exceed the minimum', () => {
    expect(() => loadSweeperSettings({ SWEEPER_STUCK_AFTER_MS: '35000' }, 35_000)).toThrow(
      /SWEEPER_STUCK_AFTER_MS/,
    );
  });

  it('the real worker requires more than the longest retry delay plus the Schematron timeout', () => {
    const env = {
      AMQP_URL: 'amqp://localhost',
      RETRY_DELAYS_MS: '1000,2000,5000',
      SCHEMATRON_TIMEOUT_MS: '30000',
    };
    const config = loadConfig({ ...env, ADAPTERS: 'real' });
    expect(() => sweeperSettings(config, { ...env, SWEEPER_STUCK_AFTER_MS: '35000' })).toThrow(
      /SWEEPER_STUCK_AFTER_MS/,
    );
    expect(sweeperSettings(config, { ...env, SWEEPER_STUCK_AFTER_MS: '35001' }).stuckAfterMs).toBe(
      35_001,
    );
    // The defaults: 2 min (longest retry delay) + 30 s (Schematron) is well below 15 minutes.
    expect(sweeperSettings(config, { AMQP_URL: 'amqp://localhost' }).stuckAfterMs).toBe(900_000);
  });
});

/**
 * The sweeper wired into the worker (in-memory adapters): a document whose message was
 * dead-lettered is found and processed after all. The interval is an hour, so the test triggers
 * the sweep itself; the threshold is 0, so the dead-lettered document counts as stuck at once.
 */
describe('sweeper in the worker (in-memory adapters)', () => {
  const lines: string[] = [];
  let adapters: InMemoryAdapters;
  let worker: INestApplicationContext;

  beforeAll(async () => {
    const destination = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(...chunk.toString().split('\n').filter(Boolean));
        done();
      },
    });
    adapters = createInMemoryAdapters({ retryDelayMs: 10 });
    worker = await (
      await Test.createTestingModule({
        imports: [
          WorkerModule.register(inMemoryProviders(adapters), undefined, {
            logging: { level: 'info', destination },
            sweeper: { intervalMs: 3_600_000, stuckAfterMs: 0 },
          }),
        ],
        providers: [SubmitDocumentHandler],
      }).compile()
    ).init();
    worker.useLogger(worker.get(Logger));
  });

  afterAll(async () => {
    adapters.broker.close();
    await worker.close();
  });

  const until = async <T>(probe: () => Promise<T | undefined>): Promise<T> => {
    const deadline = Date.now() + 2_000;
    for (;;) {
      const value = await probe();
      if (value !== undefined) return value;
      if (Date.now() > deadline) throw new Error('Condition not met in time');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  it('requeues a dead-lettered document, logs a warning, and the worker completes it', async () => {
    // Every delivery fails until the in-memory broker's delivery limit dead-letters the message.
    const crash = vi.spyOn(adapters.rules, 'validate').mockRejectedValue(new Error('crashed'));
    const fixture = readFileSync(join(__dirname, '../fixtures/invoice-minimal.xml'));
    const { documentId } = await worker.get(CommandBus).execute(
      new SubmitDocumentCommand({
        organisationId: 'org-supplier',
        peppolId: '0106:11111111',
        clientId: 'client-1',
        idempotencyKey: 'key-sweeper',
        xml: fixture,
        correlationId: 'corr-sweeper',
      }),
    );
    await until(async () => adapters.broker.deadLetters[0]);
    crash.mockRestore();

    const report = await worker.get(SweeperLoop).sweep();

    expect(report.requeued).toEqual([
      expect.objectContaining({ documentId, status: 'Processing', attempt: 1 }),
    ]);
    const views = worker.get(DocumentViews);
    await until(async () => {
      const view = await views.get('org-supplier', documentId);
      return view?.status === 'Completed' ? view : undefined;
    });
    const history = await worker.get(EventStore).load(documentId);
    expect(history.map((stored) => stored.event.type)).toEqual([
      'DocumentReceived',
      'ProcessingStarted',
      'ProcessingRequeued',
      'DocumentProcessed',
    ]);
    const warning = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.msg === 'Stuck document requeued');
    expect(warning).toMatchObject({
      level: 40,
      documentId,
      status: 'Processing',
      attempt: 1,
      reason: 'sweeper',
      unchangedSince: expect.any(String),
    });
  });
});
