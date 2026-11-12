import { InMemoryBroker } from '../../src/documents/adapters/outbound/in-memory/in-memory-broker';
import { InMemoryDatabase } from '../../src/documents/adapters/outbound/in-memory/in-memory-database';
import {
  InMemoryBlobStore,
  InMemoryDocumentViews,
  InMemoryEventStore,
  InMemoryIdempotencyRegistry,
  InMemoryOutbox,
  InMemoryUnitOfWork,
} from '../../src/documents/adapters/outbound/in-memory/in-memory-persistence';
import {
  type DeliveredMessageView,
  describeMessagePublisherContract,
} from '../contracts/message-publisher.contract';
import { describePersistenceContract } from '../contracts/persistence.contract';

describePersistenceContract('in-memory', async () => {
  const db = new InMemoryDatabase();
  return {
    uow: new InMemoryUnitOfWork(db),
    events: new InMemoryEventStore(db),
    views: new InMemoryDocumentViews(db),
    blobs: new InMemoryBlobStore(db),
    outbox: new InMemoryOutbox(db),
    idempotency: new InMemoryIdempotencyRegistry(db),
    reset: async () => db.reset(),
  };
});

describeMessagePublisherContract(
  'in-memory',
  async () => {
    const broker = new InMemoryBroker({ retryDelayMs: 50 });
    const deliveries: DeliveredMessageView[] = [];
    const waiters: Array<(m: DeliveredMessageView) => void> = [];
    broker.consume('process', async (m) => {
      const waiter = waiters.shift();
      if (waiter) waiter(m);
      else deliveries.push(m);
    });
    return {
      publisher: broker,
      nextProcessDelivery: (timeoutMs) =>
        new Promise((resolve, reject) => {
          const queued = deliveries.shift();
          if (queued) return resolve(queued);
          const timer = setTimeout(() => reject(new Error('no delivery')), timeoutMs);
          waiters.push((m) => {
            clearTimeout(timer);
            resolve(m);
          });
        }),
      simulateOutage: async () => {
        broker.unavailable = 'simulated outage';
        return async () => {
          broker.unavailable = undefined;
        };
      },
      close: async () => broker.close(),
    };
  },
  { retryDelayMs: 50 },
);
