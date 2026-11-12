// T2: publish to retry.1s (and retry.3s); it must arrive on documents.process after >= TTL.
import { randomUUID } from 'node:crypto';
import { retryRoutingKey } from '../src/messaging/topology';
import { RecordingHandler, purgeAll, result, shutdown, startWorker, waitFor } from './harness';

async function main() {
  const h = new RecordingHandler();
  const w = await startWorker(h);
  await purgeAll();
  let ok = true;
  const out: Record<string, unknown> = {};
  for (const [delay, min] of [['1s', 1000], ['3s', 3000]] as const) {
    const id = `t2-${delay}-${randomUUID().slice(0, 8)}`;
    const t0 = Date.now();
    await w.publisher.publish(retryRoutingKey(delay), { delay }, { messageId: id, headers: { test: 'T2' } });
    const arrived = await waitFor(() => h.completedIds().has(id), min + 10_000, 10);
    const d = h.completed.find((x) => x.messageId === id);
    const measured = d ? d.at - t0 : null;
    out[`retry.${delay}`] = { arrived, measuredMs: measured, xDeath: d?.headers['x-death'] ? (d.headers['x-death'] as any[]).map((x) => `${x.queue}:${x.reason}:${x.count}`) : null };
    ok = ok && arrived && measured !== null && measured >= min;
  }
  result('T2', ok, out);
  await shutdown(w, 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
