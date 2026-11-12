// T1: publish 200 with confirms, all consumed, report duplicates.
// Extra: (a) broker nack => publish rejects; (b) unroutable routing key => publish still RESOLVES.
import { randomUUID } from 'node:crypto';
import { EXCHANGE } from '../src/messaging/topology';
import { RecordingHandler, bind, deleteQueue, purgeAll, putQueue, result, shutdown, startWorker, waitFor } from './harness';

async function main() {
  const h = new RecordingHandler();
  const w = await startWorker(h);
  await purgeAll();
  const run = randomUUID().slice(0, 8);
  const ids = Array.from({ length: 200 }, (_, i) => `t1-${run}-${i}`);
  const t0 = Date.now();
  const settled = await Promise.allSettled(ids.map((id, i) => w.publisher.publish('process', { i, run }, { messageId: id, headers: { test: 'T1' } })));
  const confirmed = settled.filter((s) => s.status === 'fulfilled').length;
  const confirmMs = Date.now() - t0;
  await waitFor(() => h.completedIds().size >= 200, 20_000);
  await new Promise((r) => setTimeout(r, 1000)); // catch late duplicates
  const consumed = [...h.completedIds()].filter((id) => ids.includes(id)).length;
  result('T1', confirmed === 200 && consumed === 200, { published: 200, confirmed, confirmMs, consumed, duplicates: h.duplicates() });

  // (a) nack: temporary classic queue, max-length 1 + reject-publish => 2nd publish is nacked by the broker.
  await putQueue('spike.nacktest', { 'x-max-length': 1, 'x-overflow': 'reject-publish' });
  await bind(EXCHANGE, 'spike.nacktest', 'nacktest');
  const n1 = await w.publisher.publish('nacktest', { n: 1 }, { messageId: 'nack-1' }).then(() => 'resolved', (e) => `rejected: ${e.message}`);
  const n2 = await w.publisher.publish('nacktest', { n: 2 }, { messageId: 'nack-2' }).then(() => 'resolved', (e) => `rejected: ${e.message}`);
  await deleteQueue('spike.nacktest');
  result('T1a-nack', n1 === 'resolved' && n2.startsWith('rejected'), { first: n1, second: n2 });

  // (b) unroutable: no binding for this key. Broker acks unroutable messages => promise resolves, message is gone.
  const u = await w.publisher.publish('no-such-key', { x: 1 }, { messageId: 'unroutable-1' }).then(() => 'resolved', (e) => `rejected: ${e.message}`);
  result('T1b-unroutable (informational)', true, { publishOutcome: u, note: 'resolved means confirm != routed' });

  await shutdown(w, 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
