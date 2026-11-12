// T5: restart the broker while the consumer is processing slow messages.
// Nothing lost; the consumer resumes by itself (same process).
import { randomUUID } from 'node:crypto';
import { PROCESS_QUEUE } from '../src/messaging/topology';
import { RecordingHandler, trackOutage, purgeAll, queueDepth, restartBroker, result, shutdown, sleep, startWorker, waitFor, waitForMgmt } from './harness';

async function main() {
  const h = new RecordingHandler(async () => sleep(700)); // slow "DB transaction"
  const w = await startWorker(h);
  const outage = trackOutage(w);
  await purgeAll();
  const run = randomUUID().slice(0, 8);
  const ids = Array.from({ length: 20 }, (_, i) => `t5-${run}-${i}`);
  await Promise.all(ids.map((id, i) => w.publisher.publish('process', { i }, { messageId: id })));
  await waitFor(() => h.completed.length >= 4, 20_000, 20);
  const beforeRestart = h.completed.length;
  const inFlightAtRestart = h.deliveries.length - h.completed.length;
  const r = await restartBroker();
  await waitForMgmt();
  const allDone = await waitFor(() => ids.every((id) => h.completedIds().has(id)), 90_000, 250);
  await sleep(3000);
  const firstAfterRestart = h.deliveries.find((d) => d.at > r.doneAt);
  let qDepth = -1; // broker-side counters lag a few seconds after acks
  await waitFor(async () => (qDepth = await queueDepth(PROCESS_QUEUE)) === 0, 20_000, 1000);
  const redelivered = h.deliveries.filter((d) => d.redelivered);
  const done = ids.filter((id) => h.completedIds().has(id)).length;
  result('T5', allDone && done === 20 && qDepth === 0, {
    messages: 20,
    completedBeforeRestart: beforeRestart,
    inFlightAtRestart,
    completedUnique: done,
    handlerCompletionsTotal: h.completed.length,
    duplicateCompletions: h.duplicates(),
    redeliveredDeliveries: redelivered.length,
    redeliveredIds: redelivered.map((d) => `${d.messageId.split('-').pop()}(dc=${d.headers['x-delivery-count'] ?? 0})`),
    restartMode: r.mode,
    restartCmdMs: r.doneAt - r.startedAt,
    ...outage(),
    firstDeliveryAfterRestartCmdMs: firstAfterRestart ? firstAfterRestart.at - r.doneAt : null,
    queueLeft: qDepth,
  });
  await shutdown(w, 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
