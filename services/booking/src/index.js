const express = require('express');
const { Pool } = require('pg');
const { createClient } = require('redis');
const amqp = require('amqplib');
const migrate = require('./migrate');

const PORT = process.env.PORT || 4002;
const QUEUE = 'booking.confirmed';

const app = express();
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = createClient({ url: process.env.REDIS_URL });
redis.on('error', (err) => console.error('booking: redis error:', err.message));

let channel = null;

app.get('/health', async (req, res) => {
  const health = { service: 'booking', status: 'ok', postgres: 'down', redis: 'down', rabbitmq: 'down' };
  try {
    await pool.query('SELECT 1');
    health.postgres = 'ok';
  } catch {
    /* stays down */
  }
  if (redis.isOpen) health.redis = 'ok';
  if (channel) health.rabbitmq = 'ok';
  if (health.postgres !== 'ok' || health.redis !== 'ok' || health.rabbitmq !== 'ok') {
    health.status = 'degraded';
  }
  res.status(health.status === 'ok' ? 200 : 503).json(health);
});

// Scaffold demo: publishes a message so you can watch the async path end to end
// (docker compose logs notifications). Replaced by real booking flow in Phase 1.
app.post('/test-event', (req, res) => {
  if (!channel) return res.status(503).json({ error: 'queue not connected yet' });
  const payload = { bookingId: `test-${Date.now()}`, at: new Date().toISOString() };
  channel.sendToQueue(QUEUE, Buffer.from(JSON.stringify(payload)), { persistent: true });
  res.json({ published: payload });
});

async function connectQueue(attempts = 10) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const conn = await amqp.connect(process.env.RABBITMQ_URL);
      channel = await conn.createChannel();
      await channel.assertQueue(QUEUE, { durable: true });
      console.log('booking: connected to RabbitMQ');
      return;
    } catch {
      console.log(`booking: RabbitMQ not ready (attempt ${i}/${attempts}), retrying in 3s`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  console.error('booking: giving up on RabbitMQ');
}

async function start() {
  await migrate(pool);
  await redis.connect();
  connectQueue();
  app.listen(PORT, () => console.log(`booking service listening on :${PORT}`));
}

start().catch((err) => {
  console.error('booking failed to start:', err);
  process.exit(1);
});
