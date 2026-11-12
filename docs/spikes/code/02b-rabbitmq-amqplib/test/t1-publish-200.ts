import { bootApp, report, resetBroker, sleep, waitFor } from './helpers';

async function main() {
  await resetBroker();
  const { app, publisher, consumer } = await bootApp();
  const seen = new Map<string, number>();
  await consumer.start(async (_payload, msg) => {
    const id = String(msg.properties.messageId);
    seen.set(id, (seen.get(id) ?? 0) + 1);
  });

  const N = 200;
  const t0 = Date.now();
  const results = await Promise.allSettled(
    Array.from({ length: N }, (_, i) =>
      publisher.publish('process', { invoiceId: i }, { messageId: `t1-${i}`, headers: { test: 't1' } }),
    ),
  );
  const confirmed = results.filter((r) => r.status === 'fulfilled').length;
  const confirmMs = Date.now() - t0;

  await waitFor(() => seen.size >= N, 20_000);
  await sleep(1_000); // linger to catch late duplicates
  const duplicates = [...seen.values()].filter((c) => c > 1).length;

  // Side check: an unroutable message must reject (basic.return), not resolve.
  const unroutable = await publisher
    .publish('no-such-routing-key', {}, { messageId: 't1-unroutable' })
    .then(() => 'RESOLVED (bad)', (e: Error) => `rejected: ${e.message}`);

  report('T1 publish 200 with confirms', confirmed === N && seen.size === N && unroutable.startsWith('rejected'), {
    published: N, confirmed, rejected: N - confirmed, consumedUnique: seen.size, duplicates, confirmMs, unroutable,
  });
  await app.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
