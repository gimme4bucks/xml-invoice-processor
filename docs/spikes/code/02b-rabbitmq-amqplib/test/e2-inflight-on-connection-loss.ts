/**
 * E2 (experiment): deterministic "sent but unconfirmed" messages. Freeze the broker
 * (docker pause), publish 20 messages, let the heartbeat kill the connection, then
 * unpause. Compares amqp-connection-manager's built-in publish with our adapter.
 */
import * as amqplib from 'amqplib';
import amqp from 'amqp-connection-manager';
import type { ConfirmChannel } from 'amqplib';
import { QUEUE } from '../src/amqp/topology';
import { AMQP_URL, bootApp, CONTAINER, docker, report, resetBroker, sleep, waitFor, waitForBroker } from './helpers';

const Q = 'spike.e2';
type Outcome = { resolved: number; rejected: Record<string, number>; settledAfterMs: number[] };

function track(p: Promise<unknown>, o: Outcome, t0: () => number) {
  return p.then(
    () => { o.resolved++; o.settledAfterMs.push(Date.now() - t0()); },
    (e: Error) => { o.rejected[e.message] = (o.rejected[e.message] ?? 0) + 1; o.settledAfterMs.push(Date.now() - t0()); },
  );
}

async function drain(queue: string): Promise<Map<string, number>> {
  const conn = await amqplib.connect(AMQP_URL);
  const ch = await conn.createChannel();
  const seen = new Map<string, number>();
  for (let m = await ch.get(queue, { noAck: true }); m; m = await ch.get(queue, { noAck: true })) {
    const id = String(m.properties.messageId);
    seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  await conn.close();
  return seen;
}

async function main() {
  await resetBroker();
  const raw = await amqplib.connect(AMQP_URL);
  await (await raw.createChannel()).deleteQueue(Q);
  await raw.close();

  // A: amqp-connection-manager built-in publish (no timeout)
  const manager = amqp.connect([AMQP_URL], { heartbeatIntervalInSeconds: 2, reconnectTimeInSeconds: 1 });
  const wrapper = manager.createChannel({
    json: true,
    setup: (ch: ConfirmChannel) => ch.assertQueue(Q, { durable: true, arguments: { 'x-queue-type': 'quorum' } }).then(() => undefined),
  });
  await wrapper.waitForConnect();
  // B: our adapter (no consumer started, messages stay in documents.process)
  const { app, publisher } = await bootApp();

  let pausedAt = 0;
  const a: Outcome = { resolved: 0, rejected: {}, settledAfterMs: [] };
  const b: Outcome = { resolved: 0, rejected: {}, settledAfterMs: [] };
  await docker('pause', CONTAINER);
  pausedAt = Date.now();
  const pending: Promise<unknown>[] = [];
  for (let i = 0; i < 20; i++) {
    pending.push(track(wrapper.sendToQueue(Q, { i }, { persistent: true, messageId: `a-${i}` }), a, () => pausedAt));
    pending.push(track(publisher.publish('process', { i }, { messageId: `b-${i}` }), b, () => pausedAt));
  }
  const inFlightA = (wrapper as any)._unconfirmedMessages.length;
  await waitFor(() => !manager.isConnected(), 30_000, 200);
  const disconnectedAfterMs = Date.now() - pausedAt;
  await sleep(1_000);
  const beforeUnpause = { a: { ...a, settledAfterMs: undefined }, b: { ...b, settledAfterMs: undefined } };
  await docker('unpause', CONTAINER);
  await waitForBroker();
  await Promise.race([Promise.all(pending), sleep(30_000)]);
  await sleep(3_000);
  await manager.close();
  await app.close();

  const inA = await drain(Q);
  const inB = await drain(QUEUE);
  report('E2 sent-but-unconfirmed on connection loss', true, {
    disconnectedAfterMs,
    acm: { sentUnconfirmedAtPause: inFlightA, beforeUnpause: beforeUnpause.a, final: { resolved: a.resolved, rejected: a.rejected }, inQueue: inA.size, dupes: [...inA.values()].filter((c) => c > 1).length },
    adapter: { beforeUnpause: beforeUnpause.b, final: { resolved: b.resolved, rejected: b.rejected }, inQueue: inB.size },
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
