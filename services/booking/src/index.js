const express = require('express');
const { Pool } = require('pg');
const { createClient } = require('redis');
const amqp = require('amqplib');
const migrate = require('./migrate');

const PORT = process.env.PORT || 4002;
const QUEUE = 'booking.confirmed';
const HOLD_TTL_SECONDS = parseInt(process.env.HOLD_TTL_SECONDS || '300', 10);
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:8080';
const SWEEP_INTERVAL_MS = parseInt(process.env.SWEEP_INTERVAL_MS || '60000', 10);
// How long to wait for the payment service before declaring the outcome
// UNKNOWN. Must exceed the gateway's own proxy-error latency, or a real 5xx
// arrives as a client-side abort instead of the 5xx it really is.
const PAYMENT_TIMEOUT_MS = parseInt(process.env.PAYMENT_TIMEOUT_MS || '5000', 10);
const RECONNECT_DELAY_MS = parseInt(process.env.RECONNECT_DELAY_MS || '3000', 10);

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

// Shared by every seat endpoint. Types matter: Redis stringifies values, so a
// numeric userId would hold a seat it could never book ("42" !== 42).
function validateIds(body) {
  const { eventId, seatId, userId } = body || {};
  if (
    typeof eventId !== 'string' || !eventId ||
    typeof seatId !== 'string' || !seatId ||
    typeof userId !== 'string' || !userId
  ) {
    return 'eventId, seatId and userId are required strings';
  }
  if (!UUID_RE.test(seatId)) return 'seatId must be a UUID';
  return null;
}

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
    const invalid = validateIds(req.body);
    if (invalid) return res.status(400).json({ error: invalid });
    const { eventId, seatId, userId } = req.body;

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
    const invalid = validateIds(req.body);
    if (invalid) return res.status(400).json({ error: invalid });
    const { eventId, seatId, userId } = req.body;

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

// The booking transaction (see DESIGN.md "Book" flow). The pending row is
// inserted BEFORE calling payment: from that moment the unique index protects
// the seat, so a hold expiring mid-payment cannot cause a double-booking.
// Deliberately NOT one DB transaction — never hold locks across network calls;
// the pending row itself is the lock.
app.post(
  '/bookings',
  ah(async (req, res) => {
    const invalid = validateIds(req.body);
    if (invalid) return res.status(400).json({ error: invalid });
    const { eventId, seatId, userId, simulatePaymentFailure } = req.body;

    // 1) Only the hold owner may book.
    const holder = await redis.get(holdKey(eventId, seatId));
    if (holder !== userId) {
      return res.status(409).json({ error: 'you must hold the seat before booking' });
    }

    const seat = await pool.query(
      'SELECT label, price_cents FROM seats WHERE id = $1 AND event_id = $2',
      [seatId, eventId]
    );
    if (seat.rowCount === 0) return res.status(404).json({ error: 'seat not found for this event' });
    const { label, price_cents: priceCents } = seat.rows[0];

    // 2) Claim the seat in Postgres. The partial unique index is the law:
    // under any race, exactly one pending/confirmed row can exist per seat.
    let bookingId;
    try {
      const r = await pool.query(
        `INSERT INTO bookings (seat_id, event_id, user_id, status, expires_at)
         VALUES ($1, $2, $3, 'pending', now() + make_interval(secs => $4))
         RETURNING id`,
        [seatId, eventId, userId, HOLD_TTL_SECONDS]
      );
      bookingId = r.rows[0].id;
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'seat already booked' });
      throw err;
    }

    // 3) Take payment (via the gateway — services never call each other directly).
    // Outcomes are three-valued (DESIGN.md): succeeded, rejected, or UNKNOWN.
    let resp;
    try {
      resp = await fetch(`${GATEWAY_URL}/api/payment/payments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bookingId,
          amountCents: priceCents,
          idempotencyKey: bookingId,
          simulate: simulatePaymentFailure ? 'fail' : undefined,
        }),
        signal: AbortSignal.timeout(PAYMENT_TIMEOUT_MS),
      });
    } catch (err) {
      // UNKNOWN: timeout/network — the charge may exist server-side. Never
      // cancel here; the booking stays pending and the reconciling sweep
      // resolves it against the payment record either way.
      console.error(`booking: payment outcome unknown for ${bookingId}:`, err.message);
      return res.status(502).json({
        error: 'payment status unknown; booking will be resolved automatically',
        bookingId,
      });
    }
    if (!resp.ok) {
      // 5xx is UNKNOWN, not a rejection. It covers payment crashing after its
      // INSERT committed, and the gateway's own 502/504 when payment is slow or
      // restarting — in both cases the charge may exist. Cancelling here would
      // strand it: the sweep only revisits *pending* bookings, so a cancelled-
      // but-charged seat is never reconciled. Leave it pending instead.
      if (resp.status >= 500) {
        console.error(`booking: payment outcome unknown for ${bookingId}: HTTP ${resp.status}`);
        return res.status(502).json({
          error: 'payment status unknown; booking will be resolved automatically',
          bookingId,
        });
      }
      // 4xx: payment service understood the request and refused it — no charge.
      await settleBooking(bookingId, 'cancelled');
      await releaseHold(eventId, seatId, userId);
      return res.status(502).json({ error: 'payment request rejected', bookingId });
    }
    const payment = await resp.json();

    // 4) Settle the outcome (guarded: only a still-pending row transitions).
    if (payment.status !== 'succeeded') {
      await settleBooking(bookingId, 'cancelled', payment.paymentId);
      await releaseHold(eventId, seatId, userId);
      return res.status(402).json({ error: 'payment failed', bookingId });
    }

    const confirmed = await settleBooking(bookingId, 'confirmed', payment.paymentId);
    if (!confirmed) {
      // The sweep settled this booking while payment was in flight (only
      // reachable with extreme TTL/timeout misconfiguration). The charge is
      // recorded under this bookingId; the sweep's reconciliation owns the
      // outcome — do not override it here.
      console.error(`booking: ${bookingId} was settled during payment — not overriding`);
      return res.status(409).json({
        error: 'booking expired during payment; it will be resolved automatically',
        bookingId,
      });
    }
    publishConfirmed({
      bookingId,
      eventId,
      seatId,
      seatLabel: label,
      userId,
      priceCents,
      confirmedAt: new Date().toISOString(),
    });
    await releaseHold(eventId, seatId, userId);
    res.status(201).json({ bookingId, status: 'confirmed', paymentId: payment.paymentId, seatLabel: label });
  })
);

app.get(
  '/bookings/:id',
  ah(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'invalid booking id' });
    const r = await pool.query(
      `SELECT id, seat_id, event_id, user_id, status, payment_id, created_at, updated_at
       FROM bookings WHERE id = $1`,
      [req.params.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'booking not found' });
    res.json(r.rows[0]);
  })
);

app.use((err, req, res, next) => {
  console.error('booking: unhandled error:', err.message);
  res.status(500).json({ error: 'internal error' });
});

// Every pending→terminal transition goes through here. The status guard makes
// settlement race-safe: a booking the sweep already resolved stays resolved
// (no resurrection, no double-settle). Returns whether this call won.
async function settleBooking(bookingId, status, paymentId = null) {
  const r = await pool.query(
    `UPDATE bookings SET status = $2, payment_id = $3, updated_at = now()
     WHERE id = $1 AND status = 'pending'`,
    [bookingId, status, paymentId]
  );
  return r.rowCount === 1;
}

async function releaseHold(eventId, seatId, userId) {
  try {
    await redis.eval(RELEASE_SCRIPT, { keys: [holdKey(eventId, seatId)], arguments: [userId] });
  } catch (err) {
    console.error('booking: hold release failed (will expire via TTL):', err.message);
  }
}

// Known Phase 1 gap (see DESIGN.md): if the process dies between payment
// success and this publish, the event is lost. The outbox pattern fixes this
// in Phase 3.
function publishConfirmed(payload) {
  if (!channel) {
    console.error('booking: RabbitMQ channel down — booking.confirmed NOT published:', payload.bookingId);
    return;
  }
  channel.sendToQueue(QUEUE, Buffer.from(JSON.stringify(payload)), { persistent: true });
}

// The reconciling sweep (DESIGN.md): expired pending bookings are resolved
// against the payment record — the payment outcome, not the timer, decides.
// A paid booking is confirmed (recovered), an unpaid one is cancelled, and an
// unreachable payment service means "retry next cycle", never "assume unpaid".
async function sweepExpiredPendings() {
  const { rows } = await pool.query(
    `SELECT b.id, b.seat_id, b.event_id, b.user_id, s.label, s.price_cents
     FROM bookings b JOIN seats s ON s.id = b.seat_id
     WHERE b.status = 'pending' AND b.expires_at < now()
     LIMIT 100`
  );
  for (const b of rows) {
    let payment = null; // null = definitively no charge for this key
    try {
      const resp = await fetch(`${GATEWAY_URL}/api/payment/payments/key/${b.id}`, {
        signal: AbortSignal.timeout(3000),
      });
      if (resp.ok) payment = await resp.json();
      else if (resp.status !== 404) continue; // payment service unhealthy — retry next cycle
    } catch {
      continue; // unreachable — retry next cycle
    }

    if (payment && payment.status === 'succeeded') {
      if (await settleBooking(b.id, 'confirmed', payment.paymentId)) {
        console.log(`booking: sweep recovered paid booking ${b.id} — confirmed`);
        publishConfirmed({
          bookingId: b.id,
          eventId: b.event_id,
          seatId: b.seat_id,
          seatLabel: b.label,
          userId: b.user_id,
          priceCents: b.price_cents,
          confirmedAt: new Date().toISOString(),
        });
      }
    } else if (await settleBooking(b.id, 'cancelled', payment ? payment.paymentId : null)) {
      console.log(`booking: sweep cancelled stale pending booking ${b.id}`);
    }
  }
}

function startSweep() {
  setInterval(
    () => sweepExpiredPendings().catch((err) => console.error('booking: sweep error:', err.message)),
    SWEEP_INTERVAL_MS
  );
}

// Never gives up: the server keeps confirming bookings while the broker is
// down, so abandoning reconnection would silently drop every future event.
async function connectQueue() {
  for (let attempt = 1; ; attempt++) {
    let conn = null;
    try {
      conn = await amqp.connect(process.env.RABBITMQ_URL);
      // Attached immediately: an 'error' event with no listener would take the
      // process down before setup finishes.
      conn.on('error', (err) => console.error('booking: RabbitMQ error:', err.message));

      const ch = await conn.createChannel();
      await ch.assertQueue(QUEUE, { durable: true });

      // Only once the queue is asserted: a failure during setup is retried by
      // this loop, and must not also spawn a second loop from here.
      conn.on('close', () => {
        channel = null;
        console.error('booking: RabbitMQ connection closed — reconnecting');
        setTimeout(connectQueue, RECONNECT_DELAY_MS);
      });

      // Published to only after assertQueue, so /health never reports 'ok' for
      // a channel that cannot yet accept a booking.confirmed.
      channel = ch;
      console.log('booking: connected to RabbitMQ');
      return;
    } catch {
      if (conn) await conn.close().catch(() => {});
      if (attempt === 1 || attempt % 10 === 0) {
        console.log(
          `booking: RabbitMQ not ready (attempt ${attempt}), retrying in ${RECONNECT_DELAY_MS}ms`
        );
      }
      await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));
    }
  }
}

async function start() {
  await migrate(pool);
  await redis.connect();
  connectQueue();
  startSweep();
  app.listen(PORT, () => console.log(`booking service listening on :${PORT}`));
}

start().catch((err) => {
  console.error('booking failed to start:', err);
  process.exit(1);
});
