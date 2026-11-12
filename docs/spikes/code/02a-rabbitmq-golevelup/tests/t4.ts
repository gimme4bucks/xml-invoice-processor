// T4: restart the broker in the middle of publishing 500 messages.
// Every publish must resolve (confirmed) or reject; every confirmed message must be consumed.
import { randomUUID } from 'node:crypto';
import { PROCESS_QUEUE } from '../src/messaging/topology';
import { RecordingHandler, trackOutage, purgeAll, queueDepth, restartBroker, result, shutdown, sleep, startWorker, waitFor, waitForMgmt } from './harness';

async function main() {
  const h = new RecordingHandler();
  const w = await startWorker(h);
  const outage = trackOutage(w);
  await purgeAll();
  const run = randomUUID().slice(0, 8);
  const N = 500;
  const confirmed = new Set<string>();
  const rejected = new Map<string, string>();
  const pending: Promise<void>[] = [];
  let restart: ReturnType<typeof restartBroker> | undefined;
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    const id = `t4-${run}-${i}`;
    pending.push(
      w.publisher.publish('process', { i }, { messageId: id }).then(
        () => void confirmed.add(id),
        (e) => void rejected.set(id, e.message),
      ),
    );
    if (i === 100) restart = restartBroker();
    await sleep(20);
  }
  const publishLoopMs = Date.now() - t0;
  const allSettled = await Promise.race([Promise.all(pending).then(() => true), sleep(30_000).then(() => false)]);
  const r = await restart!;
  await waitForMgmt();
  await waitFor(() => [...confirmed].every((id) => h.completedIds().has(id)), 60_000, 250);
  await sleep(2000);
  const consumedIds = h.completedIds();
  const lostConfirmed = [...confirmed].filter((id) => !consumedIds.has(id));
  const rejectedButConsumed = [...rejected.keys()].filter((id) => consumedIds.has(id));
  const reasons: Record<string, number> = {};
  for (const m of rejected.values()) reasons[m] = (reasons[m] ?? 0) + 1;
  let qDepth = -1; // broker-side counters lag a few seconds after acks
  await waitFor(async () => (qDepth = await queueDepth(PROCESS_QUEUE)) === 0, 20_000, 1000);
  result("T4", qDepth === 0 && allSettled && confirmed.size + rejected.size === N && lostConfirmed.length === 0, {
    published: N,
    confirmed: confirmed.size,
    rejected: rejected.size,
    unsettled: N - confirmed.size - rejected.size,
    rejectReasons: reasons,
    consumedUnique: [...consumedIds].filter((id) => id.startsWith(`t4-${run}`)).length,
    lostConfirmed: lostConfirmed.length,
    rejectedButConsumed: rejectedButConsumed.length,
    duplicatesConsumed: h.duplicates(),
    restartMode: r.mode,
    restartCmdMs: r.doneAt - r.startedAt,
    ...outage(),
    publishLoopMs,
    queueLeft: qDepth,
  });
  await shutdown(w, 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
