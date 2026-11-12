import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { INestApplicationContext, LogLevel } from '@nestjs/common';
import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WorkerModule } from '../src/messaging/worker.module';
import { DocumentPublisher } from '../src/messaging/publisher';
import { DeliveryMeta, DocumentHandler } from '../src/messaging/consumer';
import { DLQ, PROCESS_QUEUE } from '../src/messaging/topology';

export const CONTAINER = 'spike-rmq-a';
export const AMQP_URI = 'amqp://guest:guest@localhost:5673';
const MGMT = 'http://localhost:15673/api';
const AUTH = 'Basic ' + Buffer.from('guest:guest').toString('base64');

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const now = () => Date.now();
export const evt = (o: Record<string, unknown>) => process.stdout.write('EVT ' + JSON.stringify(o) + '\n');

export interface Delivery extends DeliveryMeta {
  payload: any;
  at: number;
}

/** Test handler: records every delivery that reached the handler, then runs `behaviour`. */
export class RecordingHandler implements DocumentHandler {
  deliveries: Delivery[] = [];
  completed: Delivery[] = [];
  constructor(public behaviour: (payload: any, meta: DeliveryMeta) => Promise<void> = async () => undefined) {}
  async handle(payload: any, meta: DeliveryMeta) {
    const d = { ...meta, payload, at: now() };
    this.deliveries.push(d);
    await this.behaviour(payload, meta);
    this.completed.push(d);
  }
  completedIds() {
    return new Set(this.completed.map((d) => d.messageId));
  }
  duplicates() {
    return this.completed.length - this.completedIds().size;
  }
}

export interface Worker {
  app: INestApplicationContext;
  publisher: DocumentPublisher;
  amqp: AmqpConnection;
}

export async function startWorker(handler?: DocumentHandler, consume = true): Promise<Worker> {
  const levels: LogLevel[] = process.env.VERBOSE ? ['log', 'warn', 'error'] : ['warn', 'error'];
  const app = await NestFactory.createApplicationContext(WorkerModule.register({ uri: AMQP_URI, consume, handler }), {
    logger: levels,
  });
  await app.init();
  return { app, publisher: app.get(DocumentPublisher), amqp: app.get(AmqpConnection) };
}

async function mgmt(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(MGMT + path, {
    method,
    headers: { authorization: AUTH, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok && res.status !== 404) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  const txt = await res.text();
  return txt ? JSON.parse(txt) : undefined;
}
export const queueInfo = (q: string) => mgmt('GET', `/queues/%2F/${encodeURIComponent(q)}`);
export const purge = (q: string) => mgmt('DELETE', `/queues/%2F/${encodeURIComponent(q)}/contents`);
export const getMessages = (q: string, count: number) =>
  mgmt('POST', `/queues/%2F/${encodeURIComponent(q)}/get`, { count, ackmode: 'ack_requeue_false', encoding: 'auto' });
export const putQueue = (q: string, args: Record<string, unknown>) =>
  mgmt('PUT', `/queues/%2F/${encodeURIComponent(q)}`, { durable: true, auto_delete: false, arguments: args });
export const deleteQueue = (q: string) => mgmt('DELETE', `/queues/%2F/${encodeURIComponent(q)}`);
export const bind = (ex: string, q: string, rk: string) =>
  mgmt('POST', `/bindings/%2F/e/${encodeURIComponent(ex)}/q/${encodeURIComponent(q)}`, { routing_key: rk });

export async function purgeAll() {
  for (const q of [PROCESS_QUEUE, DLQ, 'documents.retry.1s', 'documents.retry.3s']) await purge(q);
}

export async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs: number, stepMs = 100): Promise<boolean> {
  const end = now() + timeoutMs;
  while (now() < end) {
    if (await cond()) return true;
    await sleep(stepMs);
  }
  return !!(await cond());
}

/**
 * Non-blocking (event loop keeps running) broker restart.
 * mode 'restart' = docker restart (graceful, short outage);
 * 'stop<N>' = docker stop, N s down, docker start; 'kill<N>' = docker kill (SIGKILL), N s down, start.
 */
export async function restartBroker(mode = process.env.RESTART_MODE ?? 'restart'): Promise<{ startedAt: number; doneAt: number; mode: string }> {
  const sh = promisify(execFile);
  const startedAt = now();
  const m = /^(stop|kill)(\d+)$/.exec(mode);
  if (!m) await sh('docker', ['restart', CONTAINER]);
  else {
    await sh('docker', [m[1], CONTAINER]);
    await sleep(Number(m[2]) * 1000);
    await sh('docker', ['start', CONTAINER]);
  }
  return { startedAt, doneAt: now(), mode };
}

/** Records connection-level outage as seen by amqp-connection-manager. */
export function trackOutage(w: Worker) {
  const o = { disconnects: 0, firstDisconnectAt: 0, reconnectedAt: 0 };
  w.amqp.managedConnection.on('disconnect', () => {
    o.disconnects++;
    o.firstDisconnectAt ||= now();
  });
  w.amqp.managedConnection.on('connect', () => {
    if (o.firstDisconnectAt) o.reconnectedAt = now();
  });
  return () => ({ disconnects: o.disconnects, outageMs: o.reconnectedAt && o.firstDisconnectAt ? o.reconnectedAt - o.firstDisconnectAt : null });
}

export async function waitForMgmt(timeoutMs = 60_000) {
  return waitFor(async () => {
    try {
      const q = await queueInfo(PROCESS_QUEUE);
      return !!q && q.state === 'running';
    } catch {
      return false;
    }
  }, timeoutMs, 500);
}

export function result(name: string, pass: boolean, numbers: Record<string, unknown>) {
  console.log(`\n${name}: ${pass ? 'PASS' : 'FAIL'} ${JSON.stringify(numbers)}`);
}

export async function shutdown(w: Worker, code: number) {
  await Promise.race([w.app.close(), sleep(5000)]);
  process.exit(code);
}

/** Authoritative queue depth (ready + unacked) via rabbitmqctl; mgmt API stats lag after a restart. */
export async function queueDepth(q: string): Promise<number> {
  const { stdout } = await promisify(execFile)('docker', ['exec', CONTAINER, 'rabbitmqctl', '-q', 'list_queues', 'name', 'messages']);
  const line = stdout.split('\n').find((l) => l.split('\t')[0] === q);
  return line ? Number(line.split('\t')[1]) : -1;
}
