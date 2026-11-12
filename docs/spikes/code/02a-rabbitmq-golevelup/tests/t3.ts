// T3: poison message always throws -> nack(requeue) -> after delivery limit -> DLQ. Others unaffected.
import { randomUUID } from 'node:crypto';
import { DLQ, PROCESS_QUEUE } from '../src/messaging/topology';
import { RecordingHandler, getMessages, purgeAll, queueInfo, result, shutdown, startWorker, waitFor } from './harness';

async function main() {
  const h = new RecordingHandler(async (p) => {
    if (p.poison) throw new Error('poison!');
    await new Promise((r) => setTimeout(r, 20));
  });
  const w = await startWorker(h);
  await purgeAll();
  const run = randomUUID().slice(0, 8);
  const poisonId = `t3-poison-${run}`;
  const goodIds = Array.from({ length: 10 }, (_, i) => `t3-good-${run}-${i}`);
  await w.publisher.publish('process', { poison: true }, { messageId: poisonId });
  await Promise.all(goodIds.map((id, i) => w.publisher.publish('process', { i }, { messageId: id })));

  const tW = Date.now();
  const dlqOk = await waitFor(async () => (await queueInfo(DLQ))?.messages === 1, 30_000, 200);
  const dlqWaitMs = Date.now() - tW;
  await waitFor(() => goodIds.every((id) => h.completedIds().has(id)), 10_000);
  const poisonAttempts = h.deliveries.filter((d) => d.messageId === poisonId);
  const goodDone = goodIds.filter((id) => h.completedIds().has(id)).length;
  const proc = await queueInfo(PROCESS_QUEUE);
  const [dlqMsg] = (await getMessages(DLQ, 1)) ?? [];
  const hdr = dlqMsg?.properties?.headers ?? {};
  result('T3', dlqOk && goodDone === 10 && dlqMsg?.properties?.message_id === poisonId, {
    dlqOk, dlqWaitMs,
    poisonDeliveries: poisonAttempts.length,
    xDeliveryCountSeenByHandler: poisonAttempts.map((d) => d.headers['x-delivery-count'] ?? null),
    redeliveredFlags: poisonAttempts.map((d) => d.redelivered),
    goodConsumed: goodDone,
    goodDuplicates: h.completed.filter((d) => goodIds.includes(d.messageId)).length - goodDone,
    dlqMessageId: dlqMsg?.properties?.message_id,
    dlqHeaders: {
      'x-first-death-reason': hdr['x-first-death-reason'],
      'x-first-death-queue': hdr['x-first-death-queue'],
      'x-delivery-count': hdr['x-delivery-count'],
      'x-death': hdr['x-death'],
    },
    processQueueAfter: { messages: proc?.messages },
  });
  await shutdown(w, 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
