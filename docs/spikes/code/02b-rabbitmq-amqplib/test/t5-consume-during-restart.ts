import { AmqpConnection } from '../src/amqp/amqp-connection';
import { bootApp, CONTAINER, docker, report, resetBroker, sleep, waitFor } from './helpers';

async function main() {
  await resetBroker();
  const { app, publisher, consumer } = await bootApp();

  const N = 20, HANDLE_MS = 700;
  const commits = new Map<string, number>(); // simulated DB: messageId -> times committed
  let redeliveries = 0, commitsAfterReconnect = 0, disconnectedAt = 0, reconnectedAt = 0, firstCommitAfterReconnectAt = 0;
  const redeliveredXDeliveryCount: string[] = [];
  const manager = app.get(AmqpConnection).manager;
  manager.on('disconnect', () => { disconnectedAt ||= Date.now(); });
  manager.on('connect', () => { if (disconnectedAt) reconnectedAt ||= Date.now(); });
  await consumer.start(async (_p, msg) => {
    await sleep(HANDLE_MS); // slow "DB transaction"
    const id = String(msg.properties.messageId);
    commits.set(id, (commits.get(id) ?? 0) + 1);
    if (msg.fields.redelivered) {
      redeliveries++;
      redeliveredXDeliveryCount.push(`${id}:${msg.properties.headers?.['x-delivery-count'] ?? '-'}`);
    }
    if (reconnectedAt) {
      commitsAfterReconnect++;
      firstCommitAfterReconnectAt ||= Date.now();
    }
  });

  await Promise.all(Array.from({ length: N }, (_, i) => publisher.publish('process', { i }, { messageId: `t5-${i}` })));
  await sleep(2_500); // a few messages done, two in flight (prefetch 2)
  const committedBeforeRestart = commits.size;
  await docker('restart', CONTAINER);

  const done = await waitFor(() => commits.size === N, 90_000, 250);
  await sleep(1_500);
  const totalCommits = [...commits.values()].reduce((a, b) => a + b, 0);
  report('T5 broker restart during slow consumption', done && commitsAfterReconnect > 0, {
    messages: N,
    committedUnique: commits.size,
    committedBeforeRestart,
    totalHandlerCommits: totalCommits,
    duplicateCommits: totalCommits - commits.size,
    redeliveries,
    redeliveredXDeliveryCount,
    commitsAfterReconnect,
    brokerDownMs: reconnectedAt - disconnectedAt,
    firstCommitMsAfterReconnect: firstCommitAfterReconnectAt ? firstCommitAfterReconnectAt - reconnectedAt : null,
    lost: N - commits.size,
  });
  await app.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
