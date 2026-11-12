// T7 (extra): does a channel-level error (publish to a missing exchange => 404 channel close)
// leave the library's default (publishing) channel dead while the connection stays up?
import { randomUUID } from 'node:crypto';
import { RecordingHandler, purgeAll, result, shutdown, sleep, startWorker, waitFor } from './harness';

async function main() {
  const h = new RecordingHandler();
  const w = await startWorker(h);
  await purgeAll();
  const bad = await w.amqp.publish('no-such-exchange', 'x', { a: 1 }, { timeout: 5000 } as any).then(() => 'resolved', (e) => `rejected: ${e.message}`);
  await sleep(500);
  const outcomes: string[] = [];
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    const o = await w.publisher.publish('process', { i }, { messageId: `t7-${randomUUID().slice(0, 6)}` }).then(() => 'resolved', (e) => `rejected: ${e.message}`);
    outcomes.push(`${o} after ${Date.now() - t0}ms`);
  }
  await waitFor(() => h.completed.length >= 3, 3000);
  result('T7-channel-error (informational)', true, { badPublish: bad, nextPublishes: outcomes, consumerStillReceives: h.completed.length, connected: w.amqp.connected });
  await shutdown(w, 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
