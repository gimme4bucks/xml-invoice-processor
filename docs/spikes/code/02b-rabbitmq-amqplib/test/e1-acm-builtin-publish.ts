/**
 * E1 (experiment, not part of the adapter): how does amqp-connection-manager's OWN
 * ChannelWrapper.publish() behave across a broker restart? Does it buffer, and does
 * a resolved promise still mean "confirmed by the broker"?
 */
import * as amqplib from 'amqplib';
import amqp from 'amqp-connection-manager';
import type { ConfirmChannel } from 'amqplib';
import { AMQP_URL, BOUNCE, bounceBroker, report, sleep, waitForBroker } from './helpers';

const Q = 'spike.e1';

async function main() {
  const raw = await amqplib.connect(AMQP_URL);
  const rch = await raw.createChannel();
  await rch.deleteQueue(Q);
  await raw.close();

  const manager = amqp.connect([AMQP_URL], { heartbeatIntervalInSeconds: 5, reconnectTimeInSeconds: 1 });
  let connected = true, disconnects = 0, maxBuffered = 0;
  manager.on('disconnect', () => { connected = false; disconnects++; });
  manager.on('connect', () => { connected = true; });
  const wrapper = manager.createChannel({
    json: true,
    confirm: true,
    setup: (ch: ConfirmChannel) => ch.assertQueue(Q, { durable: true, arguments: { 'x-queue-type': 'quorum' } }).then(() => undefined),
  });
  await wrapper.waitForConnect();
  // Peek at the wrapper's private state: how many were sent-but-unconfirmed when the connection dropped?
  let unconfirmedAtDisconnect = -1;
  manager.on('disconnect', () => { unconfirmedAtDisconnect = (wrapper as any)._unconfirmedMessages.length; });

  // E1_BATCH>1 = burst mode, so messages are in flight (sent, unconfirmed) when the broker goes down.
  const BATCH = Number(process.env.E1_BATCH ?? 1);
  const N = 300 * BATCH, PACE_MS = 40, RESTART_AT = 60 * BATCH;
  const resolved = new Set<string>();
  const rejected = new Map<string, string>();
  let calledWhileDisconnected = 0, resolvedThoughCalledWhileDisconnected = 0;
  const pending: Promise<void>[] = [];
  let restart: Promise<void> | undefined;
  for (let i = 0; i < N; i++) {
    if (i === RESTART_AT) restart = bounceBroker();
    const id = `e1-${i}`;
    const whileDown = !connected;
    if (whileDown) calledWhileDisconnected++;
    pending.push(
      wrapper.sendToQueue(Q, { i }, { persistent: true, messageId: id, timeout: 60_000 }).then(
        () => { resolved.add(id); if (whileDown) resolvedThoughCalledWhileDisconnected++; },
        (e: Error) => void rejected.set(id, e.message),
      ),
    );
    maxBuffered = Math.max(maxBuffered, wrapper.queueLength());
    if (i % BATCH === BATCH - 1) await sleep(PACE_MS);
  }
  await Promise.all(pending);
  await restart;
  await waitForBroker();
  await sleep(2_000);
  await manager.close();

  // Drain the queue and compare with what the wrapper claimed was confirmed.
  const conn = await amqplib.connect(AMQP_URL);
  const ch = await conn.createChannel();
  const inQueue = new Map<string, number>();
  for (let m = await ch.get(Q, { noAck: true }); m; m = await ch.get(Q, { noAck: true })) {
    const id = String(m.properties.messageId);
    inQueue.set(id, (inQueue.get(id) ?? 0) + 1);
  }
  await ch.deleteQueue(Q);
  await conn.close();

  const reasons: Record<string, number> = {};
  for (const r of rejected.values()) reasons[r] = (reasons[r] ?? 0) + 1;
  const lostResolved = [...resolved].filter((id) => !inQueue.has(id)).length;
  report(`E1 amqp-connection-manager built-in publish across ${BOUNCE} (batch=${BATCH})`, lostResolved === 0, {
    published: N, resolved: resolved.size, rejected: rejected.size, rejectReasons: reasons,
    disconnects, unconfirmedAtDisconnect, calledWhileDisconnected, resolvedThoughCalledWhileDisconnected, maxBuffered,
    inQueueUnique: inQueue.size, duplicatesInQueue: [...inQueue.values()].filter((c) => c > 1).length,
    lostResolved,
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
