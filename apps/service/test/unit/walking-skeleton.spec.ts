import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplicationContext } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createInMemoryAdapters,
  type InMemoryAdapters,
  inMemoryProviders,
} from '../../src/app/adapters';
import { ApiModule, WorkerModule } from '../../src/app/modules';
import {
  SubmitDocumentCommand,
  type SubmitDocumentResult,
} from '../../src/documents/application/commands/submit-document';
import { IdempotencyConflictError } from '../../src/documents/application/errors';
import type { DocumentView } from '../../src/documents/application/ports';
import {
  GetDocumentHistoryQuery,
  GetDocumentQuery,
  type HistoryEntry,
} from '../../src/documents/application/queries/document-queries';

/**
 * Walking skeleton: the API and worker modules, wired exactly as in production but with
 * in-memory adapters, run one document end to end through intake, outbox, relay, broker
 * and processing. Each work package swaps one in-memory adapter for the real one.
 */
const fixture = readFileSync(join(__dirname, '../fixtures/invoice-minimal.xml'));
const org = { organisationId: 'org-supplier', peppolId: '0106:11111111', clientId: 'client-1' };

describe('walking skeleton (in-memory adapters)', () => {
  let adapters: InMemoryAdapters;
  let api: INestApplicationContext;
  let worker: INestApplicationContext;

  beforeAll(async () => {
    adapters = createInMemoryAdapters({ retryDelayMs: 10 });
    const providers = inMemoryProviders(adapters);
    api = await (
      await Test.createTestingModule({ imports: [ApiModule.register(providers)] }).compile()
    ).init();
    worker = await (
      await Test.createTestingModule({ imports: [WorkerModule.register(providers)] }).compile()
    ).init();
  });

  afterAll(async () => {
    adapters.broker.close();
    await worker.close();
    await api.close();
  });

  const submit = (idempotencyKey: string, xml = fixture): Promise<SubmitDocumentResult> =>
    api
      .get(CommandBus)
      .execute(
        new SubmitDocumentCommand({ ...org, idempotencyKey, xml, correlationId: idempotencyKey }),
      );

  const waitForFinal = async (documentId: string): Promise<DocumentView> => {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const view: DocumentView = await api
        .get(QueryBus)
        .execute(new GetDocumentQuery(org.organisationId, documentId));
      if (view.status === 'Completed' || view.status === 'Failed') return view;
      if (Date.now() > deadline) throw new Error(`Document still ${view.status}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  const historyTypes = async (documentId: string): Promise<string[]> => {
    const history: HistoryEntry[] = await api
      .get(QueryBus)
      .execute(new GetDocumentHistoryQuery(org.organisationId, documentId));
    return history.map((h) => h.type);
  };

  it('takes a document from intake to Completed', async () => {
    const { documentId, replayed } = await submit('key-happy');
    expect(replayed).toBe(false);
    const view = await waitForFinal(documentId);
    expect(view).toMatchObject({ status: 'Completed', direction: 'sales', attempts: 1 });
    expect(await historyTypes(documentId)).toEqual([
      'DocumentReceived',
      'ProcessingStarted',
      'DocumentProcessed',
    ]);
  });

  it('retries after a transient VAT-service outage and then completes', async () => {
    adapters.vat.failNext = 1;
    const xml = Buffer.from(fixture.toString().replace('INV-2026-0042', 'INV-RETRY'));
    const { documentId } = await submit('key-retry', xml);
    const view = await waitForFinal(documentId);
    expect(view).toMatchObject({ status: 'Completed', attempts: 2 });
    expect(await historyTypes(documentId)).toEqual([
      'DocumentReceived',
      'ProcessingStarted',
      'ProcessingAttemptFailed',
      'ProcessingStarted',
      'DocumentProcessed',
    ]);
  });

  it('fails permanently on a fatal business-rule violation', async () => {
    adapters.rules.violations = [
      { ruleId: 'BR-CO-15', flag: 'fatal', message: 'totals', location: '/Invoice' },
    ];
    try {
      const xml = Buffer.from(fixture.toString().replace('INV-2026-0042', 'INV-RULES'));
      const view = await waitForFinal((await submit('key-rules', xml)).documentId);
      expect(view.status).toBe('Failed');
      expect(view.failure?.code).toBe('BUSINESS_RULES_VIOLATED');
    } finally {
      adapters.rules.violations = [];
    }
  });

  it('replays a repeated request and rejects a reused key with other content', async () => {
    const xml = Buffer.from(fixture.toString().replace('INV-2026-0042', 'INV-IDEMPOTENT'));
    const first = await submit('key-idem', xml);
    expect(await submit('key-idem', xml)).toEqual({ documentId: first.documentId, replayed: true });
    const other = Buffer.from(xml.toString().replace('INV-IDEMPOTENT', 'INV-OTHER'));
    await expect(submit('key-idem', other)).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
});
