import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInMemoryAdapters } from '../../../src/app/adapters';
import {
  InMemoryBlobStore,
  InMemoryDocumentViews,
  InMemoryEventStore,
  InMemoryIdempotencyRegistry,
  InMemoryOutbox,
  InMemoryUnitOfWork,
} from '../../../src/documents/adapters/outbound/in-memory/in-memory-persistence';
import {
  ProcessDocumentCommand,
  ProcessDocumentHandler,
  type ProcessOutcome,
} from '../../../src/documents/application/commands/process-document';
import {
  RequeueDocumentCommand,
  RequeueDocumentHandler,
  type RequeueResult,
} from '../../../src/documents/application/commands/requeue-document';
import {
  SubmitDocumentCommand,
  SubmitDocumentHandler,
  type SubmitDocumentResult,
} from '../../../src/documents/application/commands/submit-document';
import {
  Clock,
  type DocumentView,
  IdGenerator,
  type OutboxMessage,
  type Transaction,
} from '../../../src/documents/application/ports';
import type { DocumentEvent } from '../../../src/documents/domain/document-events';

export const fixture = readFileSync(join(__dirname, '../../fixtures/invoice-minimal.xml'));

/** The fixture's parties: the supplier submits it as a sales invoice, the customer as a purchase. */
export const supplier = {
  organisationId: 'org-supplier',
  peppolId: '0106:11111111',
  clientId: 'client-supplier',
};
export const customer = {
  organisationId: 'org-customer',
  peppolId: '0106:22222222',
  clientId: 'client-customer',
};
export type Organisation = typeof supplier;

/** The VAT numbers in the fixture. */
export const supplierVat = 'NL001234567B01';
export const customerVat = 'NL009876543B01';

/** The fixture under another invoice number: other bytes, so another content hash. */
export const invoice = (invoiceNumber: string): Buffer =>
  Buffer.from(fixture.toString().replace('INV-2026-0042', invoiceNumber));

/** One second later on every call, so `receivedAt` and the list order are deterministic. */
class SteppingClock extends Clock {
  private seconds = 0;
  now(): Date {
    return new Date(Date.UTC(2026, 10, 12, 10, 0, this.seconds++));
  }
}

class SequentialIds extends IdGenerator {
  private last = 0;
  newId(): string {
    return `id-${++this.last}`;
  }
}

/**
 * The command handlers on the in-memory adapters, without Nest and without a broker: a test
 * hands outbox messages to the worker itself (`deliver`), so every duplicate, crash and
 * interleaving is explicit and deterministic. Inject faults by spying on a port method, e.g.
 * `vi.spyOn(h.events, 'append').mockRejectedValueOnce(...)`.
 */
export function createHarness() {
  const adapters = createInMemoryAdapters();
  const { db } = adapters;
  const ports = {
    uow: new InMemoryUnitOfWork(db),
    events: new InMemoryEventStore(db),
    views: new InMemoryDocumentViews(db),
    blobs: new InMemoryBlobStore(db),
    outbox: new InMemoryOutbox(db),
    idempotency: new InMemoryIdempotencyRegistry(db),
    structure: adapters.structure,
    mapper: adapters.mapper,
    rules: adapters.rules,
    vat: adapters.vat,
    clock: new SteppingClock(),
    ids: new SequentialIds(),
  };
  requireUnitOfWorkTx(ports);

  const submitHandler = new SubmitDocumentHandler(
    ports.structure,
    ports.mapper,
    ports.uow,
    ports.events,
    ports.views,
    ports.blobs,
    ports.outbox,
    ports.idempotency,
    ports.clock,
    ports.ids,
  );
  const processHandler = new ProcessDocumentHandler(
    ports.uow,
    ports.events,
    ports.views,
    ports.blobs,
    ports.outbox,
    ports.rules,
    ports.mapper,
    ports.vat,
    ports.clock,
    ports.ids,
  );

  const requeueHandler = new RequeueDocumentHandler(
    ports.uow,
    ports.events,
    ports.views,
    ports.outbox,
    ports.clock,
    ports.ids,
  );

  return {
    ...ports,
    db,
    requeueHandler,
    /** Sends a stuck document to the worker again, as the DLQ re-drive or the sweeper does. */
    requeue(input: RequeueDocumentCommand['input']): Promise<RequeueResult> {
      return requeueHandler.execute(new RequeueDocumentCommand(input));
    },
    submit(
      options: { org?: Organisation; key?: string; xml?: Buffer } = {},
    ): Promise<SubmitDocumentResult> {
      const { org = supplier, key = 'key-1', xml = fixture } = options;
      return submitHandler.execute(
        new SubmitDocumentCommand({ ...org, idempotencyKey: key, xml, correlationId: `c-${key}` }),
      );
    },
    /** Hands a message to the worker, as the consumer does with a broker delivery. */
    deliver(message: OutboxMessage): Promise<ProcessOutcome> {
      return processHandler.execute(
        new ProcessDocumentCommand({
          documentId: String(message.payload['documentId']),
          attempt: Number(message.payload['attempt']),
          messageId: message.id,
          correlationId: message.headers['x-correlation-id'] ?? message.id,
        }),
      );
    },
    /** Every message ever enqueued, oldest first, published or not. */
    outboxMessages(): OutboxMessage[] {
      return db.tables.outbox.map(({ id, routingKey, payload, headers }) => ({
        id,
        routingKey,
        payload,
        headers,
      }));
    },
    /** The most recently enqueued message. */
    lastMessage(): OutboxMessage {
      const message = db.tables.outbox.at(-1);
      if (!message) throw new Error('The outbox is empty');
      return message;
    },
    async eventsOf(documentId: string): Promise<DocumentEvent[]> {
      return (await ports.events.load(documentId)).map((stored) => stored.event);
    },
    async eventTypes(documentId: string): Promise<string[]> {
      return (await ports.events.load(documentId)).map((stored) => stored.event.type);
    },
    view(documentId: string, org: Organisation = supplier): Promise<DocumentView | undefined> {
      return ports.views.get(org.organisationId, documentId);
    },
  };
}

export type Harness = ReturnType<typeof createHarness>;

/**
 * Hard rule 2: every write runs inside `UnitOfWork.run` and passes that run's own tx. The
 * in-memory adapters ignore the tx, so the harness checks it on every write of every test.
 */
function requireUnitOfWorkTx(ports: {
  uow: InMemoryUnitOfWork;
  events: InMemoryEventStore;
  views: InMemoryDocumentViews;
  blobs: InMemoryBlobStore;
  outbox: InMemoryOutbox;
  idempotency: InMemoryIdempotencyRegistry;
}): void {
  const running = new Set<Transaction>();
  const { uow, events, views, blobs, outbox, idempotency } = ports;
  const run = uow.run.bind(uow);
  uow.run = <T>(work: (tx: Transaction) => Promise<T>): Promise<T> =>
    run(async (tx) => {
      running.add(tx);
      try {
        return await work(tx);
      } finally {
        running.delete(tx);
      }
    });
  const check = (write: string, tx: Transaction): void => {
    if (!running.has(tx)) throw new Error(`${write} outside its unit of work (hard rule 2)`);
  };

  const append = events.append.bind(events);
  events.append = (streamId, expectedVersion, list, metadata, tx) => {
    check('events.append', tx);
    return append(streamId, expectedVersion, list, metadata, tx);
  };
  const upsert = views.upsert.bind(views);
  views.upsert = (view, tx) => {
    check('views.upsert', tx);
    return upsert(view, tx);
  };
  const put = blobs.put.bind(blobs);
  blobs.put = (blob, tx) => {
    check('blobs.put', tx);
    return put(blob, tx);
  };
  const enqueue = outbox.enqueue.bind(outbox);
  outbox.enqueue = (messages, tx) => {
    check('outbox.enqueue', tx);
    return enqueue(messages, tx);
  };
  const register = idempotency.register.bind(idempotency);
  idempotency.register = (record, tx) => {
    check('idempotency.register', tx);
    return register(record, tx);
  };
}
