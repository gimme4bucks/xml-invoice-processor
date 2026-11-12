import { describe, expect, it } from 'vitest';
import { DocumentNotFoundError } from '../../src/documents/application/errors';
import {
  GetDocumentHandler,
  GetDocumentHistoryHandler,
  GetDocumentHistoryQuery,
  GetDocumentQuery,
  GetDocumentResultHandler,
  GetDocumentResultQuery,
  ListDocumentsHandler,
  ListDocumentsQuery,
} from '../../src/documents/application/queries/document-queries';
import { createHarness, customer, invoice, supplier } from './support/harness';

const queries = (h: ReturnType<typeof createHarness>) => ({
  get: (organisationId: string, documentId: string) =>
    new GetDocumentHandler(h.views).execute(new GetDocumentQuery(organisationId, documentId)),
  list: (organisationId: string, options: ListDocumentsQuery['options']) =>
    new ListDocumentsHandler(h.views).execute(new ListDocumentsQuery(organisationId, options)),
  result: (organisationId: string, documentId: string) =>
    new GetDocumentResultHandler(h.views, h.blobs).execute(
      new GetDocumentResultQuery(organisationId, documentId),
    ),
  history: (organisationId: string, documentId: string) =>
    new GetDocumentHistoryHandler(h.views, h.events).execute(
      new GetDocumentHistoryQuery(organisationId, documentId),
    ),
});

describe('document queries (in-memory adapters)', () => {
  it("organisation scoping: another organisation, even the invoice's other party, gets DocumentNotFoundError", async () => {
    const h = createHarness();
    const q = queries(h);
    const { documentId } = await h.submit({ org: supplier });
    await h.deliver(h.lastMessage());
    const other = customer.organisationId;

    await expect(q.get(other, documentId)).rejects.toBeInstanceOf(DocumentNotFoundError);
    await expect(q.result(other, documentId)).rejects.toBeInstanceOf(DocumentNotFoundError);
    await expect(q.history(other, documentId)).rejects.toBeInstanceOf(DocumentNotFoundError);
    expect(await q.list(other, { limit: 10 })).toEqual({ items: [] });

    // The owner sees it.
    expect(await q.get(supplier.organisationId, documentId)).toMatchObject({ documentId });
  });

  it('an unknown document id: DocumentNotFoundError', async () => {
    const q = queries(createHarness());
    await expect(q.get(supplier.organisationId, 'nope')).rejects.toBeInstanceOf(
      DocumentNotFoundError,
    );
  });

  it('list: newest first, page by page, with a status filter', async () => {
    const h = createHarness();
    const q = queries(h);
    const ids: string[] = [];
    for (const n of [1, 2, 3]) {
      ids.push((await h.submit({ key: `key-${n}`, xml: invoice(`INV-${n}`) })).documentId);
    }
    const [first, second, third] = ids;
    await h.deliver(h.outboxMessages()[0]!); // completes the first document
    await h.submit({ org: customer, key: 'key-c', xml: invoice('INV-C') }); // another organisation

    const page1 = await q.list(supplier.organisationId, { limit: 2 });
    expect(page1.items.map((v) => v.documentId)).toEqual([third, second]);
    expect(page1.nextCursor).toEqual(expect.any(String));
    const page2 = await q.list(supplier.organisationId, { limit: 2, cursor: page1.nextCursor });
    expect(page2.items.map((v) => v.documentId)).toEqual([first]);
    expect(page2.nextCursor).toBeUndefined();

    const completed = await q.list(supplier.organisationId, { limit: 10, status: 'Completed' });
    expect(completed.items.map((v) => [v.documentId, v.status])).toEqual([[first, 'Completed']]);
    const received = await q.list(supplier.organisationId, { limit: 10, status: 'Received' });
    expect(received.items.map((v) => v.documentId)).toEqual([third, second]);
  });

  it('result: only available once Completed', async () => {
    const h = createHarness();
    const q = queries(h);
    h.vat.failNext = 1;
    const { documentId } = await h.submit();
    expect(await q.result(supplier.organisationId, documentId)).toEqual({ status: 'Received' });

    await h.deliver(h.lastMessage()); // VAT service down: retry scheduled
    expect(await q.result(supplier.organisationId, documentId)).toEqual({ status: 'Processing' });

    await h.deliver(h.lastMessage());
    expect(await q.result(supplier.organisationId, documentId)).toEqual({
      status: 'Completed',
      result: {
        documentId,
        direction: 'sales',
        invoice: expect.objectContaining({ invoiceNumber: 'INV-2026-0042', currency: 'EUR' }),
      },
    });
  });

  it('result: a Failed document has none', async () => {
    const h = createHarness();
    h.rules.violations = [{ ruleId: 'BR-01', flag: 'fatal', message: 'x', location: '/' }];
    const { documentId } = await h.submit();
    await h.deliver(h.lastMessage());
    expect(await queries(h).result(supplier.organisationId, documentId)).toEqual({
      status: 'Failed',
    });
  });

  it('history: every event in version order', async () => {
    const h = createHarness();
    h.vat.failNext = 1;
    const { documentId } = await h.submit();
    await h.deliver(h.lastMessage());
    await h.deliver(h.lastMessage());

    const history = await queries(h).history(supplier.organisationId, documentId);

    expect(history.map((entry) => [entry.version, entry.type])).toEqual([
      [1, 'DocumentReceived'],
      [2, 'ProcessingStarted'],
      [3, 'ProcessingAttemptFailed'],
      [4, 'ProcessingStarted'],
      [5, 'DocumentProcessed'],
    ]);
    expect(history[2]?.event).toMatchObject({
      type: 'ProcessingAttemptFailed',
      attempt: 1,
      reason: { code: 'VAT_SERVICE_UNAVAILABLE' },
    });
    expect(history.every((entry) => entry.occurredAt instanceof Date)).toBe(true);
  });
});
