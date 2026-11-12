// Diagnostic only (raw amqplib, not part of the adapter): what do nack(requeue) / reject / channel-close do to the delivery count on this broker?
const amqp = require('amqplib');
(async () => {
  const conn = await amqp.connect('amqp://guest:guest@localhost:5673');
  const mode = process.argv[2];
  const q = 'probe.' + mode;
  let ch = await conn.createConfirmChannel();
  await ch.deleteQueue(q);
  await ch.assertQueue(q, { durable: true, arguments: { 'x-queue-type': 'quorum', 'x-delivery-limit': 3 } });
  ch.sendToQueue(q, Buffer.from('{}'), { persistent: true, messageId: 'p1' });
  await ch.waitForConfirms();
  const seen = [];
  for (let i = 0; i < 8; i++) {
    let m = false;
    for (let k = 0; k < 10 && !m; k++) { m = await ch.get(q, { noAck: false }); if (!m) await new Promise(r => setTimeout(r, 100)); }
    if (!m) { seen.push('none'); break; }
    const h = m.properties.headers || {};
    seen.push(`dc=${h['x-delivery-count']} ac=${h['x-acquired-count']} redel=${m.fields.redelivered}`);
    if (mode === 'nack') ch.nack(m, false, true);
    else if (mode === 'reject') ch.reject(m, true);
    else if (mode === 'close') { await ch.close(); ch = await conn.createConfirmChannel(); }
    await new Promise(r => setTimeout(r, 100));
  }
  const info = await ch.checkQueue(q);
  console.log(mode.padEnd(6), JSON.stringify(seen), 'left in queue:', info.messageCount);
  await ch.deleteQueue(q);
  await conn.close();
})().catch(e => { console.error(e); process.exit(1); });
