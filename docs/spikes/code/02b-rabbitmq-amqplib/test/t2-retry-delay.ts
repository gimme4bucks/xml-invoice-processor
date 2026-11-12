import { bootApp, report, resetBroker, waitFor } from './helpers';

async function main() {
  await resetBroker();
  const { app, publisher, consumer } = await bootApp();
  const arrived = new Map<string, { at: number; deathCount: number; deathQueue: string }>();
  await consumer.start(async (_payload, msg) => {
    const death = (msg.properties.headers?.['x-death'] as any[] | undefined)?.[0];
    arrived.set(String(msg.properties.messageId), {
      at: Date.now(), deathCount: death?.count ?? 0, deathQueue: death?.queue ?? '-',
    });
  });

  const cases = [
    { key: 'retry.1s', id: 't2-1s', minMs: 1_000 },
    { key: 'retry.3s', id: 't2-3s', minMs: 3_000 },
  ];
  const sentAt: Record<string, number> = {};
  for (const c of cases) {
    sentAt[c.id] = Date.now();
    await publisher.publish(c.key, { invoiceId: c.id }, { messageId: c.id });
  }
  await waitFor(() => arrived.size === cases.length, 15_000);

  const numbers: Record<string, unknown> = {};
  let pass = true;
  for (const c of cases) {
    const a = arrived.get(c.id);
    const delay = a ? a.at - sentAt[c.id] : null;
    numbers[c.key] = a ? { delayMs: delay, xDeathQueue: a.deathQueue, xDeathCount: a.deathCount } : 'NOT ARRIVED';
    pass &&= delay !== null && delay >= c.minMs;
  }
  report('T2 retry queue TTL -> documents.process', pass, numbers);
  await app.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
