import { bootApp, BOUNCE, bounceBroker, report, resetBroker, sleep, waitFor, waitForBroker } from './helpers';

async function main() {
  await resetBroker();
  const { app, publisher, consumer } = await bootApp();
  const consumed = new Map<string, number>();
  await consumer.start(async (_p, msg) => {
    const id = String(msg.properties.messageId);
    consumed.set(id, (consumed.get(id) ?? 0) + 1);
  });

  const N = 500, PACE_MS = 40, RESTART_AT = 100;
  const confirmed = new Set<string>();
  const rejected = new Map<string, string>();
  const pending: Promise<void>[] = [];
  let restart: Promise<void> | undefined;
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    if (i === RESTART_AT) restart = bounceBroker(); // async, does not block the loop
    const id = `t4-${i}`;
    pending.push(
      publisher.publish('process', { i }, { messageId: id }).then(
        () => void confirmed.add(id),
        (e: Error) => void rejected.set(id, e.message),
      ),
    );
    await sleep(PACE_MS);
  }
  await Promise.all(pending);
  const publishMs = Date.now() - t0;
  await restart;
  await waitForBroker();

  const allConfirmedConsumed = await waitFor(() => [...confirmed].every((id) => consumed.has(id)), 60_000, 500);
  await sleep(2_000);

  const idx = (id: string) => Number(id.slice(3));
  const lostConfirmed = [...confirmed].filter((id) => !consumed.has(id));
  const reasons: Record<string, number> = {};
  for (const r of rejected.values()) reasons[r] = (reasons[r] ?? 0) + 1;
  const pass = confirmed.size + rejected.size === N && lostConfirmed.length === 0 && allConfirmedConsumed;
  report(`T4 publish 500 during broker ${BOUNCE}`, pass, {
    published: N,
    confirmed: confirmed.size,
    rejected: rejected.size,
    settled: confirmed.size + rejected.size,
    consumedUnique: consumed.size,
    lostConfirmed: lostConfirmed.length,
    rejectedButStillDelivered: [...rejected.keys()].filter((id) => consumed.has(id)).length,
    duplicatesConsumed: [...consumed.values()].filter((c) => c > 1).length,
    confirmedAfterRestart: [...confirmed].filter((id) => idx(id) >= RESTART_AT).length,
    rejectedIndexRange: rejected.size ? [Math.min(...[...rejected.keys()].map(idx)), Math.max(...[...rejected.keys()].map(idx))] : null,
    rejectReasons: reasons,
    publishMs,
  });
  await app.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
