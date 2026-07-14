const express = require('express');
const { Pool } = require('pg');
const { createClient } = require('redis');
const amqp = require('amqplib');
const migrate = require('./migrate');

const PORT = process.env.PORT || 4002;
const QUEUE = 'booking.confirmed';
const HOLD_TTL_SECONDS = parseInt(process.env.HOLD_TTL_SECONDS || '300', 10);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const app = express();
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = createClient({ url: process.env.REDIS_URL });
redis.on('error', (err) => console.error('booking: redis error:', err.message));

let channel = null;

const holdKey = (eventId, seatId) => `hold:${eventId}:${seatId}`;

// Express 4 doesn't catch async rejections; every async route goes through this.
const ah = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// Atomic check-and-delete: only the hold's owner may release it. GET-then-DEL
// would race (hold expires, someone else claims, we delete *their* hold).
const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end`;

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

// Claim a seat for HOLD_TTL_SECONDS while the user pays. Redis SET NX is the
// atomic first-come-first-served decision; see DESIGN.md.
app.post(
  '/holds',
  ah(async (req, res) => {
    const { eventId, seatId, userId } = req.body || {};
    if (!eventId || !seatId || !userId) {
      return res.status(400).json({ error: 'eventId, seatId and userId are required' });
    }
    if (!UUID_RE.test(seatId)) return res.status(400).json({ error: 'seatId must be a UUID' });

    const seat = await pool.query('SELECT 1 FROM seats WHERE id = $1 AND event_id = $2', [seatId, eventId]);
    if (seat.rowCount === 0) return res.status(404).json({ error: 'seat not found for this event' });

    const booked = await pool.query(
      "SELECT 1 FROM bookings WHERE seat_id = $1 AND status <> 'cancelled'",
      [seatId]
    );
    if (booked.rowCount > 0) return res.status(409).json({ error: 'seat already booked' });

    const claimed = await redis.set(holdKey(eventId, seatId), userId, {
      NX: true,
      EX: HOLD_TTL_SECONDS,
    });
    if (claimed === 'OK') {
      return res.status(201).json({
        seatId,
        userId,
        expiresAt: new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString(),
      });
    }

    // NX lost: someone holds it. If it's this same user, report their existing
    // hold instead of failing (double-click safe).
    const holder = await redis.get(holdKey(eventId, seatId));
    if (holder === userId) {
      const ttl = await redis.ttl(holdKey(eventId, seatId));
      return res.status(200).json({
        seatId,
        userId,
        expiresAt: new Date(Date.now() + Math.max(ttl, 0) * 1000).toISOString(),
      });
    }
    return res.status(409).json({ error: 'seat already held' });
  })
);

// Owner releases their hold early (picked a different seat, closed checkout).
app.delete(
  '/holds',
  ah(async (req, res) => {
    const { eventId, seatId, userId } = req.body || {};
    if (!eventId || !seatId || !userId) {
      return res.status(400).json({ error: 'eventId, seatId and userId are required' });
    }

    const key = holdKey(eventId, seatId);
    const released = await redis.eval(RELEASE_SCRIPT, { keys: [key], arguments: [userId] });
    if (released === 1) return res.status(204).end();

    const holder = await redis.get(key);
    if (!holder) return res.status(404).json({ error: 'no hold on this seat' });
    return res.status(403).json({ error: 'hold owned by another user' });
  })
);

// Availability = derived, never stored: active booking beats hold beats free.
app.get(
  '/events/:eventId/seats',
  ah(async (req, res) => {
    const { eventId } = req.params;
    const { rows } = await pool.query(
      `SELECT s.id, s.label, s.price_cents, (b.id IS NOT NULL) AS booked
       FROM seats s
       LEFT JOIN bookings b ON b.seat_id = s.id AND b.status <> 'cancelled'
       WHERE s.event_id = $1
       ORDER BY s.label`,
      [eventId]
    );
    if (rows.length === 0) return res.json({ eventId, seats: [] });

    const holds = await redis.mGet(rows.map((r) => holdKey(eventId, r.id)));
    res.json({
      eventId,
      seats: rows.map((r, i) => ({
        id: r.id,
        label: r.label,
        priceCents: r.price_cents,
        status: r.booked ? 'booked' : holds[i] ? 'held' : 'available',
      })),
    });
  })
);

// Scaffold demo: publishes a message so you can watch the async path end to end
// (docker compose logs notifications). Replaced by real booking flow next step.
app.post('/test-event', (req, res) => {
  if (!channel) return res.status(503).json({ error: 'queue not connected yet' });
  const payload = { bookingId: `test-${Date.now()}`, at: new Date().toISOString() };
  channel.sendToQueue(QUEUE, Buffer.from(JSON.stringify(payload)), { persistent: true });
  res.json({ published: payload });
});

app.use((err, req, res, next) => {
  console.error('booking: unhandled error:', err.message);
  res.status(500).json({ error: 'internal error' });
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
