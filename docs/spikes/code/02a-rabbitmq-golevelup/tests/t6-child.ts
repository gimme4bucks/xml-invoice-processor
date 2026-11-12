// T6 child: consumer process. With KILL_BEFORE_ACK=1 it SIGKILLs itself after the handler
// resolved (DB commit done) but before the library sends basic.ack.
import { CONSUMER_CHANNEL } from '../src/messaging/topology';
import { RecordingHandler, evt, sleep, startWorker } from './harness';

async function main() {
  const h = new RecordingHandler(async (_p, meta) => {
    evt({ type: 'committed', pid: process.pid, id: meta.messageId, redelivered: meta.redelivered, deliveryCount: meta.headers['x-delivery-count'] ?? 0 });
  });
  const w = await startWorker(h);
  if (process.env.KILL_BEFORE_ACK) {
    // Test hook: the library calls channel.ack(msg) right after `await handler()` (connection.js:317).
    const ch = w.amqp.channels[CONSUMER_CHANNEL] as any;
    ch.ack = () => {
      evt({ type: 'killing-before-ack', pid: process.pid });
      process.kill(process.pid, 'SIGKILL');
    };
  }
  evt({ type: 'ready', pid: process.pid });
  if (!process.env.KILL_BEFORE_ACK) {
    while (h.completed.length === 0) await sleep(50);
    await sleep(500); // let the ack flush
    await w.app.close();
    process.exit(0);
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
