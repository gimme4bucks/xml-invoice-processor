/** Child process for T6. KILL_BEFORE_ACK=1 -> SIGKILL itself after commit, before ack. */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { bootApp, sleep, waitFor } from './helpers';

async function main() {
  const db = process.env.T6_DB!; // the "database": an append-only file
  const kill = process.env.KILL_BEFORE_ACK === '1';
  const { app, consumer } = await bootApp();
  let handled = 0;
  await consumer.start(
    async (_p, msg) => {
      const id = String(msg.properties.messageId);
      // Idempotency check, as the real consumer would do with a processed_messages table.
      const already = existsSync(db) && readFileSync(db, 'utf8').split('\n').some((l) => l.startsWith(`commit ${id} `));
      appendFileSync(db, `${already ? 'duplicate-skipped' : 'commit'} ${id} pid=${process.pid} redelivered=${msg.fields.redelivered} x-delivery-count=${msg.properties.headers?.['x-delivery-count'] ?? '-'}\n`);
      handled++;
    },
    { beforeAck: () => { if (kill) process.kill(process.pid, 'SIGKILL'); } },
  );
  const ok = await waitFor(() => handled > 0, 15_000);
  await sleep(500); // let the ack reach the broker
  await app.close();
  process.exit(ok ? 0 : 2);
}

main().catch((e) => { console.error(e); process.exit(1); });
