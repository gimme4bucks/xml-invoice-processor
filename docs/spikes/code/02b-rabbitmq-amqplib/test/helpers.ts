import 'reflect-metadata';
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import * as amqplib from 'amqplib';
import { AmqpModule } from '../src/amqp/amqp.module';
import { ConfirmPublisher } from '../src/amqp/confirm-publisher';
import { DocumentConsumer } from '../src/amqp/document-consumer';
import { DLQ, QUEUE, RETRY_QUEUES } from '../src/amqp/topology';

export const CONTAINER = 'spike-rmq-b';
export const AMQP_URL = 'amqp://guest:guest@127.0.0.1:5674';
const MGMT = 'http://127.0.0.1:15674/api';
const RESULTS = join(__dirname, '..', '..', 'results.log');

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function bootApp() {
  @Module({ imports: [AmqpModule.forRoot(AMQP_URL)] })
  class TestAppModule {}
  const app = await NestFactory.createApplicationContext(TestAppModule, { logger: ['error', 'warn', 'log'] });
  app.enableShutdownHooks();
  const publisher = app.get(ConfirmPublisher);
  const consumer = app.get(DocumentConsumer);
  await publisher.waitForReady();
  return { app, publisher, consumer };
}

/** Deletes every spike queue so each test starts from a fresh, freshly-declared topology. */
export async function resetBroker(): Promise<void> {
  const conn = await amqplib.connect(AMQP_URL);
  const ch = await conn.createChannel();
  for (const q of [QUEUE, DLQ, ...RETRY_QUEUES.map((r) => r.queue)]) await ch.deleteQueue(q);
  await ch.close();
  await conn.close();
}

export async function mgmt(path: string): Promise<any> {
  const res = await fetch(`${MGMT}${path}`, {
    headers: { authorization: 'Basic ' + Buffer.from('guest:guest').toString('base64') },
  });
  if (!res.ok) throw new Error(`mgmt ${path}: ${res.status}`);
  return res.json();
}

export async function queueDepth(queue: string): Promise<number> {
  const conn = await amqplib.connect(AMQP_URL);
  const ch = await conn.createChannel();
  const { messageCount } = await ch.checkQueue(queue);
  await conn.close();
  return messageCount;
}

/** Runs a docker command without blocking the event loop. */
export function docker(...args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('docker', args, { stdio: 'ignore' });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`docker ${args.join(' ')} -> ${code}`))));
  });
}

export async function waitForBroker(timeoutMs = 60_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const c = await amqplib.connect(AMQP_URL);
      await c.close();
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error('broker did not come back');
}

export async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs: number, stepMs = 100): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await cond()) return true;
    await sleep(stepMs);
  }
  return cond();
}

export function report(test: string, pass: boolean, numbers: Record<string, unknown>): void {
  const line = `${pass ? 'PASS' : 'FAIL'} ${test} ${JSON.stringify(numbers)}`;
  console.log(`\n=== ${line}\n`);
  appendFileSync(RESULTS, `${new Date().toISOString()} ${line}\n`);
}

/** BOUNCE=kill -> SIGKILL the broker and start it again (unclean crash); default: graceful `docker restart`. */
export const BOUNCE = process.env.BOUNCE === 'kill' ? 'kill' : 'restart';
export async function bounceBroker(): Promise<void> {
  if (BOUNCE === 'kill') {
    await docker('kill', '-s', 'KILL', CONTAINER);
    await docker('start', CONTAINER);
  } else {
    await docker('restart', CONTAINER);
  }
}
