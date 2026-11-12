/**
 * T3b: does x-dead-letter-strategy=at-least-once actually protect messages on the
 * way to the DLQ? Dead-letter into an exchange with NO binding (DLQ "unavailable"),
 * then compare three quorum queues. Raw amqplib, independent of the adapter.
 */
import * as amqplib from 'amqplib';
import { AMQP_URL, mgmt, report, sleep, waitFor } from './helpers';

const TARGET_X = 'spike.dlx.target-x';
const TARGET_Q = 'spike.dlx.target';
const VARIANTS = {
  'spike.dlx.at-least-once': { 'x-dead-letter-strategy': 'at-least-once', 'x-overflow': 'reject-publish' },
  'spike.dlx.at-least-once-no-overflow': { 'x-dead-letter-strategy': 'at-least-once' }, // overflow defaults to drop-head
  'spike.dlx.at-most-once': {},
} as Record<string, Record<string, string>>;

async function main() {
  const conn = await amqplib.connect(AMQP_URL);
  const ch = await conn.createConfirmChannel();
  await ch.deleteExchange(TARGET_X);
  await ch.deleteQueue(TARGET_Q);
  await ch.assertExchange(TARGET_X, 'direct', { durable: true });
  for (const [q, args] of Object.entries(VARIANTS)) {
    await ch.deleteQueue(q);
    await ch.assertQueue(q, {
      durable: true,
      arguments: { 'x-queue-type': 'quorum', 'x-dead-letter-exchange': TARGET_X, 'x-dead-letter-routing-key': 'dead', ...args },
    });
    ch.sendToQueue(q, Buffer.from('{}'), { persistent: true, messageId: q });
  }
  await ch.waitForConfirms();

  // Dead-letter each message (reject without requeue) while the DLX has no route.
  for (const q of Object.keys(VARIANTS)) {
    const m = await ch.get(q);
    if (m) ch.reject(m, false);
  }
  await sleep(7_000); // management stats refresh every 5 s (rabbitmqctl has no messages_dlx column)
  const afterReject: Record<string, { messages: number; messages_dlx: number }> = {};
  for (const q of Object.keys(VARIANTS)) {
    const info = await mgmt(`/queues/%2F/${encodeURIComponent(q)}`);
    afterReject[q] = { messages: info.messages, messages_dlx: info.messages_dlx };
  }

  // Make the DLQ available again and see which messages arrive.
  await ch.assertQueue(TARGET_Q, { durable: true, arguments: { 'x-queue-type': 'quorum' } });
  await ch.bindQueue(TARGET_Q, TARGET_X, 'dead');
  const t0 = Date.now();
  await waitFor(async () => (await ch.checkQueue(TARGET_Q)).messageCount >= 1, 240_000, 1_000);
  const arrivedAfterMs = Date.now() - t0;
  await sleep(2_000);
  const arrived: string[] = [];
  for (let m = await ch.get(TARGET_Q); m; m = await ch.get(TARGET_Q)) {
    arrived.push(String(m.properties.messageId));
    ch.ack(m);
  }

  const alo = afterReject['spike.dlx.at-least-once'];
  report('T3b at-least-once dead-lettering', alo?.messages_dlx === 1 && arrived.length === 1 && arrived[0] === 'spike.dlx.at-least-once', {
    afterRejectWhileDlqUnroutable: afterReject,
    arrivedInDlqAfterRebind: arrived,
    arrivedAfterMs,
  });
  for (const q of [...Object.keys(VARIANTS), TARGET_Q]) await ch.deleteQueue(q);
  await ch.deleteExchange(TARGET_X);
  await conn.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
