import { spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { QUEUE } from '../src/amqp/topology';
import { bootApp, queueDepth, report, resetBroker } from './helpers';

const DB = join(__dirname, '..', '..', 't6-db.log');

function runChild(env: Record<string, string>): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(__dirname, 't6-consumer-child.js')], {
      env: { ...process.env, T6_DB: DB, ...env },
      stdio: 'inherit',
    });
    p.on('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function main() {
  rmSync(DB, { force: true });
  await resetBroker();
  const { app, publisher } = await bootApp();
  await publisher.publish('process', { invoiceId: 'inv-6' }, { messageId: 't6-1' });
  await app.close();

  const run1 = await runChild({ KILL_BEFORE_ACK: '1' });
  const run2 = await runChild({});
  const lines = readFileSync(DB, 'utf8').trim().split('\n');
  const depth = await queueDepth(QUEUE);

  console.log('\n--- t6-db.log (simulated DB) ---\n' + lines.join('\n'));
  report('T6 SIGKILL after commit, before ack', run1.signal === 'SIGKILL' && run2.code === 0 && lines.length === 2 && depth === 0, {
    run1: run1.signal ?? run1.code,
    run2: run2.signal ?? run2.code,
    deliveriesOfSameMessage: lines.length,
    secondDelivery: lines[1],
    queueDepthAfter: depth,
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
