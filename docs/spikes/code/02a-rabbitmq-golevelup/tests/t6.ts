// T6: SIGKILL the consumer after the handler resolved but before ack; on restart the message is redelivered.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PROCESS_QUEUE } from '../src/messaging/topology';
import { purgeAll, queueDepth, result, shutdown, startWorker, waitFor } from './harness';

function runChild(env: Record<string, string>) {
  const events: any[] = [];
  const child = spawn(process.execPath, [__dirname + '/t6-child.js'], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.startsWith('EVT ')) events.push(JSON.parse(line.slice(4)));
    }
  });
  const exited = new Promise<{ code: number | null; signal: string | null }>((r) => child.on('exit', (code, signal) => r({ code, signal })));
  return { events, exited };
}

async function main() {
  const pub = await startWorker(undefined, false); // publisher-only (registerHandlers: false)
  await purgeAll();
  const id = `t6-${randomUUID().slice(0, 8)}`;

  const c1 = runChild({ KILL_BEFORE_ACK: '1' });
  await waitFor(() => c1.events.some((e) => e.type === 'ready'), 20_000);
  await pub.publisher.publish('process', { doc: 1 }, { messageId: id });
  const exit1 = await c1.exited;

  const c2 = runChild({});
  const exit2 = await c2.exited;
  let depth = -1;
  await waitFor(async () => (depth = await queueDepth(PROCESS_QUEUE)) === 0, 20_000, 1000);

  const commits = [...c1.events, ...c2.events].filter((e) => e.type === 'committed' && e.id === id);
  result('T6', exit1.signal === 'SIGKILL' && commits.length === 2 && commits[1].redelivered === true && depth === 0, {
    child1: { exit: exit1, events: c1.events.map((e) => e.type) },
    child2: { exit: exit2 },
    commitsForSameMessageId: commits.map((c) => ({ pid: c.pid, redelivered: c.redelivered, xDeliveryCount: c.deliveryCount })),
    duplicateProcessing: commits.length - 1,
    queueLeft: depth,
  });
  await shutdown(pub, 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
