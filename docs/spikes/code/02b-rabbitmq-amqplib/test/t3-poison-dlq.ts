import * as amqplib from 'amqplib';
import { DLQ, QUEUE } from '../src/amqp/topology';
import { AMQP_URL, bootApp, mgmt, queueDepth, report, resetBroker, sleep, waitFor } from './helpers';

async function main() {
  await resetBroker();
  const { app, publisher, consumer } = await bootApp();
  const poisonAttempts: Array<{ redelivered: boolean; xDeliveryCount: unknown }> = [];
  const good = new Set<string>();
  await consumer.start(async (_payload, msg) => {
    const id = String(msg.properties.messageId);
    if (id === 'poison-1') {
      poisonAttempts.push({ redelivered: msg.fields.redelivered, xDeliveryCount: msg.properties.headers?.['x-delivery-count'] });
      throw new Error('poison');
    }
    good.add(id);
  });

  await publisher.publish('process', { invoiceId: 'poison' }, { messageId: 'poison-1' });
  for (let i = 0; i < 5; i++) await publisher.publish('process', { invoiceId: i }, { messageId: `good-${i}` });

  await waitFor(async () => (await queueDepth(DLQ)) === 1 && good.size === 5, 20_000, 250);
  await sleep(500);

  // Inspect the dead-lettered message without the adapter.
  const conn = await amqplib.connect(AMQP_URL);
  const ch = await conn.createChannel();
  const dead = await ch.get(DLQ, { noAck: false });
  const h = (dead && dead.properties.headers) || {};
  const death = (h['x-death'] as any[] | undefined)?.[0];
  if (dead) ch.nack(dead, false, true); // leave it in the DLQ
  await ch.close();
  await conn.close();

  const q = await mgmt(`/queues/%2F/${encodeURIComponent(QUEUE)}`);
  report('T3 poison -> DLQ after delivery limit', dead !== false && dead.properties.messageId === 'poison-1' && good.size === 5 && (await queueDepth(QUEUE)) === 0, {
    handlerAttemptsOnPoison: poisonAttempts.length,
    perAttempt: poisonAttempts,
    dlqMessageId: dead ? dead.properties.messageId : null,
    dlq_xDeliveryCount: h['x-delivery-count'],
    dlq_xFirstDeathReason: h['x-first-death-reason'],
    dlq_xDeath: death && { reason: death.reason, queue: death.queue, count: death.count },
    goodProcessed: good.size,
    processQueueArgs: q.arguments,
    processQueueDlxKeys: Object.fromEntries(Object.entries(q).filter(([k]) => /dlx|dead/i.test(k))),
  });
  await app.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
