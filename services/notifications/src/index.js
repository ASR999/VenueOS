const express = require('express');
const amqp = require('amqplib');

const PORT = process.env.PORT || 4004;
const QUEUE = 'booking.confirmed';

let consuming = false;

const app = express();

app.get('/health', (req, res) => {
  res
    .status(consuming ? 200 : 503)
    .json({ service: 'notifications', status: consuming ? 'ok' : 'starting', rabbitmq: consuming ? 'ok' : 'down' });
});

async function connectWithRetry(url, attempts = 10) {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await amqp.connect(url);
    } catch {
      console.log(`notifications: RabbitMQ not ready (attempt ${i}/${attempts}), retrying in 3s`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw new Error('could not connect to RabbitMQ');
}

async function start() {
  app.listen(PORT, () => console.log(`notifications service listening on :${PORT}`));

  const conn = await connectWithRetry(process.env.RABBITMQ_URL);
  const channel = await conn.createChannel();
  await channel.assertQueue(QUEUE, { durable: true });
  consuming = true;
  console.log(`notifications: consuming from "${QUEUE}"`);

  channel.consume(QUEUE, (msg) => {
    if (!msg) return;
    // Phase 1 turns this into a real (mock) email send with idempotency.
    console.log('notifications: booking.confirmed received:', msg.content.toString());
    channel.ack(msg);
  });
}

start().catch((err) => {
  console.error('notifications failed to start:', err);
  process.exit(1);
});
