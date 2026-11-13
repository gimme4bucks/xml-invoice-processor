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
} from '../../src/app/adapters';
import { WorkerModule } from '../../src/app/modules';
import { SubmitDocumentHandler } from '../../src/documents/application/commands/submit-document';
import { SubmitDocumentCommand } from '../../src/documents/application/commands/submit-document';

/**
 * The worker's message log, in its own file: nestjs-pino keeps one root logger per process, so
 * the destination of the first module wins (vitest isolates modules per file).
 */
const fixture = readFileSync(join(__dirname, '../fixtures/invoice-minimal.xml'));
const org = { organisationId: 'org-supplier', peppolId: '0106:11111111', clientId: 'client-1' };

describe('worker logging (in-memory adapters)', () => {
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
    // SubmitDocumentHandler is registered next to the worker, so the test can submit without
    // starting the API (which would bring its own logger).
    worker = await (
      await Test.createTestingModule({
        imports: [
          WorkerModule.register(inMemoryProviders(adapters), undefined, {
            logging: { level: 'info', destination },
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

  const entries = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);

  /** The worker's message lines for one document, once `count` of them were written. */
  const handled = async (documentId: string, count: number) => {
    const deadline = Date.now() + 2_000;
    for (;;) {
      const found = entries().filter(
        (entry) => entry.msg === 'Message handled' && entry.documentId === documentId,
      );
      if (found.length >= count) return found;
      if (Date.now() > deadline) throw new Error(`Found ${found.length} of ${count} lines`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  const submit = async (idempotencyKey: string, invoiceNumber: string) => {
    const xml = Buffer.from(fixture.toString().replace('INV-2026-0042', invoiceNumber));
    const { documentId } = await worker
      .get(CommandBus)
      .execute(
        new SubmitDocumentCommand({
          ...org,
          idempotencyKey,
          xml,
          correlationId: `corr-${idempotencyKey}`,
        }),
      );
    return documentId as string;
  };

  it('writes one JSON info line per handled message: IDs, attempt, outcome and duration', async () => {
    const documentId = await submit('key-1', 'INV-LOG-1');

    const [line] = await handled(documentId, 1);
    expect(line).toEqual({
      level: 30,
      time: expect.any(Number),
      pid: expect.any(Number),
      hostname: expect.any(String),
      context: 'ProcessMessages',
      msg: 'Message handled',
      documentId,
      attempt: 1,
      outcome: 'completed',
      durationMs: expect.any(Number),
      correlationId: 'corr-key-1',
      messageId: expect.any(String),
    });
  });

  it('logs a failing delivery as requeued, then the redelivery with its outcome', async () => {
    vi.spyOn(adapters.rules, 'validate').mockRejectedValueOnce(new Error('worker crashed'));
    const documentId = await submit('key-2', 'INV-LOG-2');

    const lines = await handled(documentId, 2);
    expect(lines.map((line) => [line.attempt, line.outcome])).toEqual([
      [1, 'requeued'],
      [1, 'completed'],
    ]);
  });

  it('a retry is its own message with its own outcome', async () => {
    adapters.vat.failNext = 1;
    const documentId = await submit('key-3', 'INV-LOG-3');

    const lines = await handled(documentId, 2);
    expect(lines.map((line) => [line.attempt, line.outcome])).toEqual([
      [1, 'retry-scheduled'],
      [2, 'completed'],
    ]);
  });

  it('never logs XML content, amounts or VAT numbers', () => {
    const output = lines.join('\n');
    expect(output).not.toContain('<');
    expect(output).not.toMatch(/NL\d{9}B\d{2}/);
    expect(output).not.toContain('121.00');
  });
});
