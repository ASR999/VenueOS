const express = require('express');
const { Pool } = require('pg');
const { createClient } = require('redis');
const amqp = require('amqplib');
const migrate = require('./migrate');
const createMetrics = require('./metrics');
const { requireAuth, serviceToken } = require('./auth');

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
const OUTBOX_INTERVAL_MS = parseInt(process.env.OUTBOX_INTERVAL_MS || '1000', 10);
const OUTBOX_BATCH = parseInt(process.env.OUTBOX_BATCH || '100', 10);
// Published rows are kept briefly for debugging, then pruned - an outbox that
// only ever grows is a slow leak.
const OUTBOX_RETENTION_HOURS = parseInt(process.env.OUTBOX_RETENTION_HOURS || '24', 10);
// Must stay under Docker's stop timeout (10s by default) or the container is
// SIGKILLed mid-drain and the whole exercise is pointless.
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '8000', 10);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const metrics = createMetrics('booking');

// Domain metrics. The default process metrics tell you the service is alive;
// these tell you whether it is doing its job.
const holdsTotal = new metrics.client.Counter({
  name: 'venueos_holds_total',
  help: 'Seat hold attempts by outcome',
  labelNames: ['outcome'], // won | lost | booked | unavailable
  registers: [metrics.register],
});
const bookingsTotal = new metrics.client.Counter({
  name: 'venueos_bookings_total',
  help: 'Booking attempts by final status',
  labelNames: ['status'], // confirmed | cancelled | conflict | unknown
  registers: [metrics.register],
});
const sweepRecoveriesTotal = new metrics.client.Counter({
  name: 'venueos_sweep_recoveries_total',
  help: 'Paid bookings the reconciling sweep recovered',
  registers: [metrics.register],
});
// The single most useful number in the system: how many confirmed bookings owe
// an event. Steady non-zero means the relay is stuck; a spike then decay is a
// broker outage healing itself.
new metrics.client.Gauge({
  name: 'venueos_outbox_backlog',
  help: 'Outbox rows not yet published',
  registers: [metrics.register],
  async collect() {
    try {
      const r = await pool.query('SELECT count(*) FROM outbox WHERE published_at IS NULL');
      this.set(Number(r.rows[0].count));
    } catch {
      // Leave the previous value rather than reporting a false zero: "no
      // backlog" and "cannot tell" must not look identical on a dashboard.
    }
  },
});

const app = express();
app.use(metrics.middleware);
app.get('/metrics', metrics.handler);
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
// disableOfflineQueue: with the default queue, commands issued while Redis is
// unreachable are held until it returns, so a hold request hangs indefinitely
// instead of failing. Fail fast, then fail closed (503) - see redisCall.
const redis = createClient({ url: process.env.REDIS_URL, disableOfflineQueue: true });
redis.on('error', (err) => console.error('booking: redis error:', err.message));

let channel = null;
let connection = null;
let server = null;
let sweepTimer = null;
let outboxTimer = null;
let relaying = false;
let shuttingDown = false;

const holdKey = (eventId, seatId) => `hold:${eventId}:${seatId}`;

// Express 4 doesn't catch async rejections; every async route goes through this.
const ah = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// Shared by every seat endpoint. userId is NOT accepted here: it comes from the
// verified token, so a caller cannot act as anyone but themselves. Before auth,
// this function validated a client-supplied userId - which is exactly how one
// user could take another's seat.
function validateIds(body) {
  const { eventId, seatId } = body || {};
  if (typeof eventId !== 'string' || !eventId || typeof seatId !== 'string' || !seatId) {
    return 'eventId and seatId are required strings';
  }
  if (!UUID_RE.test(seatId)) return 'seatId must be a UUID';
  return null;
}

// Redis being unreachable is a dependency outage (503), not a bug (500), and it
// must never be mistaken for "no hold exists" - that would let a second user
// book a seat someone is holding. Every request-path Redis call goes through
// here so the failure is uniform and fails closed.
async function redisCall(fn) {
  try {
    return await fn();
  } catch (err) {
    const wrapped = new Error(`redis unavailable: ${err.message}`);
    wrapped.status = 503;
    wrapped.publicMessage = 'seat holds are temporarily unavailable';
    throw wrapped;
  }
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
  // isReady, not isOpen: isOpen stays true while the client is merely *trying*
  // to reconnect, so health would report ok for a Redis that rejects every
  // command.
  if (redis.isReady) health.redis = 'ok';
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
  requireAuth,
  ah(async (req, res) => {
    const invalid = validateIds(req.body);
    if (invalid) return res.status(400).json({ error: invalid });
    const { eventId, seatId } = req.body;
    const userId = req.userId;

    const seat = await pool.query('SELECT 1 FROM seats WHERE id = $1 AND event_id = $2', [seatId, eventId]);
    if (seat.rowCount === 0) return res.status(404).json({ error: 'seat not found for this event' });

    const booked = await pool.query(
      "SELECT 1 FROM bookings WHERE seat_id = $1 AND status <> 'cancelled'",
      [seatId]
    );
    if (booked.rowCount > 0) {
      holdsTotal.inc({ outcome: 'booked' });
      return res.status(409).json({ error: 'seat already booked' });
    }

    const claimed = await redisCall(() =>
      redis.set(holdKey(eventId, seatId), userId, { NX: true, EX: HOLD_TTL_SECONDS })
    );
    if (claimed === 'OK') {
      holdsTotal.inc({ outcome: 'won' });
      return res.status(201).json({
        seatId,
        userId,
        expiresAt: new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString(),
      });
    }

    // NX lost: someone holds it. If it's this same user, report their existing
    // hold instead of failing (double-click safe).
    const holder = await redisCall(() => redis.get(holdKey(eventId, seatId)));
    if (holder === userId) {
      const ttl = await redisCall(() => redis.ttl(holdKey(eventId, seatId)));
      return res.status(200).json({
        seatId,
        userId,
        expiresAt: new Date(Date.now() + Math.max(ttl, 0) * 1000).toISOString(),
      });
    }
    holdsTotal.inc({ outcome: 'lost' });
    return res.status(409).json({ error: 'seat already held' });
  })
);

// Owner releases their hold early (picked a different seat, closed checkout).
app.delete(
  '/holds',
  requireAuth,
  ah(async (req, res) => {
    const invalid = validateIds(req.body);
    if (invalid) return res.status(400).json({ error: invalid });
    const { eventId, seatId } = req.body;
    const userId = req.userId;

    const key = holdKey(eventId, seatId);
    const released = await redisCall(() =>
      redis.eval(RELEASE_SCRIPT, { keys: [key], arguments: [userId] })
    );
    if (released === 1) return res.status(204).end();

    const holder = await redisCall(() => redis.get(key));
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

    const holds = await redisCall(() => redis.mGet(rows.map((r) => holdKey(eventId, r.id))));
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
  requireAuth,
  ah(async (req, res) => {
    const invalid = validateIds(req.body);
    if (invalid) return res.status(400).json({ error: invalid });
    const { eventId, seatId, simulatePaymentFailure } = req.body;
    const userId = req.userId;

    // 1) Only the hold owner may book.
    const holder = await redisCall(() => redis.get(holdKey(eventId, seatId)));
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
      if (err.code === '23505') {
        bookingsTotal.inc({ status: 'conflict' });
        return res.status(409).json({ error: 'seat already booked' });
      }
      throw err;
    }

    // 3) Take payment (via the gateway — services never call each other directly).
    // Outcomes are three-valued (DESIGN.md): succeeded, rejected, or UNKNOWN.
    let resp;
    try {
      resp = await fetch(`${GATEWAY_URL}/api/payment/payments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Booking is not a user; it authenticates as itself.
          Authorization: `Bearer ${serviceToken('booking')}`,
        },
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
      bookingsTotal.inc({ status: 'unknown' });
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
        bookingsTotal.inc({ status: 'unknown' });
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
      bookingsTotal.inc({ status: 'cancelled' });
      return res.status(402).json({ error: 'payment failed', bookingId });
    }

    const confirmed = await settleBooking(bookingId, 'confirmed', payment.paymentId, {
      type: QUEUE,
      payload: {
        bookingId,
        eventId,
        seatId,
        seatLabel: label,
        userId,
        priceCents,
        confirmedAt: new Date().toISOString(),
      },
    });
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
    // The event is already durable in the outbox; this only avoids waiting for
    // the next relay tick. If it fails, the timer picks it up.
    relayOutbox().catch(() => {});
    await releaseHold(eventId, seatId, userId);
    bookingsTotal.inc({ status: 'confirmed' });
    res.status(201).json({ bookingId, status: 'confirmed', paymentId: payment.paymentId, seatLabel: label });
  })
);

app.get(
  '/bookings/:id',
  requireAuth,
  ah(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'invalid booking id' });
    const r = await pool.query(
      `SELECT id, seat_id, event_id, user_id, status, payment_id, created_at, updated_at
       FROM bookings WHERE id = $1`,
      [req.params.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'booking not found' });
    // 404, not 403: telling a stranger "that booking exists but isn't yours"
    // confirms which ids are real. Someone else's booking simply isn't there.
    if (r.rows[0].user_id !== req.userId) {
      return res.status(404).json({ error: 'booking not found' });
    }
    res.json(r.rows[0]);
  })
);

// What the client needs to show a user their tickets - and to resolve the
// "payment status unknown" case, which previously had no visible outcome.
app.get(
  '/bookings',
  requireAuth,
  ah(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT b.id, b.seat_id, b.event_id, b.status, b.payment_id, b.created_at,
              s.label AS seat_label, s.price_cents
       FROM bookings b JOIN seats s ON s.id = b.seat_id
       WHERE b.user_id = $1
       ORDER BY b.created_at DESC
       LIMIT 50`,
      [req.userId]
    );
    res.json({ bookings: rows });
  })
);

app.use((err, req, res, next) => {
  const status = err.status || 500;
  console.error(`booking: ${status === 500 ? 'unhandled error' : 'request failed'}:`, err.message);
  res.status(status).json({ error: err.publicMessage || 'internal error' });
});

// Every pending→terminal transition goes through here. The status guard makes
// settlement race-safe: a booking the sweep already resolved stays resolved
// (no resurrection, no double-settle). Returns whether this call won.
async function settleBooking(bookingId, status, paymentId = null, event = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `UPDATE bookings SET status = $2, payment_id = $3, updated_at = now()
       WHERE id = $1 AND status = 'pending'`,
      [bookingId, status, paymentId]
    );
    if (r.rowCount !== 1) {
      await client.query('ROLLBACK');
      return false;
    }
    // THE POINT OF THE OUTBOX: this INSERT shares the transaction with the
    // UPDATE above. The booking is confirmed and the event is owed, atomically.
    // There is no instant where one is true and the other is not.
    if (event) {
      await client.query(
        'INSERT INTO outbox (aggregate_id, type, payload) VALUES ($1, $2, $3)',
        [bookingId, event.type, JSON.stringify(event.payload)]
      );
    }
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Drains the outbox to RabbitMQ. Runs on a timer and is nudged after each
// confirmation so the happy path stays fast.
//
// FOR UPDATE SKIP LOCKED lets several booking instances relay concurrently
// without publishing a row twice or waiting on each other. This does hold row
// locks across a network call - the opposite of the rule the booking path
// follows - but these locks are on outbox rows nobody contends for, and SKIP
// LOCKED turns contention into a no-op rather than a queue.
async function relayOutbox() {
  if (!channel || shuttingDown || relaying) return;
  relaying = true;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, type, payload FROM outbox
       WHERE published_at IS NULL
       ORDER BY created_at
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [OUTBOX_BATCH]
    );
    for (const row of rows) {
      // Publisher confirms: the broker must acknowledge it took the message
      // before we mark it published. sendToQueue on a plain channel reports
      // only backpressure, which says nothing about delivery.
      await new Promise((resolve, reject) => {
        channel.sendToQueue(
          row.type,
          Buffer.from(JSON.stringify(row.payload)),
          { persistent: true, messageId: row.id },
          (err) => (err ? reject(err) : resolve())
        );
      });
      await client.query('UPDATE outbox SET published_at = now() WHERE id = $1', [row.id]);
    }
    await client.query('COMMIT');
    if (rows.length > 0) console.log(`booking: relayed ${rows.length} outbox event(s)`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // Nothing was marked published, so the batch is retried whole. A publish
    // that landed just before the failure is re-sent - at-least-once, which is
    // exactly why the consumer dedupes.
    console.error('booking: outbox relay failed (will retry):', err.message);
  } finally {
    client.release();
    relaying = false;
  }
}

async function pruneOutbox() {
  try {
    const r = await pool.query(
      `DELETE FROM outbox
       WHERE published_at IS NOT NULL
         AND published_at < now() - make_interval(hours => $1)`,
      [OUTBOX_RETENTION_HOURS]
    );
    if (r.rowCount > 0) console.log(`booking: pruned ${r.rowCount} published outbox row(s)`);
  } catch (err) {
    console.error('booking: outbox prune failed:', err.message);
  }
}

async function releaseHold(eventId, seatId, userId) {
  try {
    await redis.eval(RELEASE_SCRIPT, { keys: [holdKey(eventId, seatId)], arguments: [userId] });
  } catch (err) {
    console.error('booking: hold release failed (will expire via TTL):', err.message);
  }
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
    if (shuttingDown) return;
    let payment = null; // null = definitively no charge for this key
    try {
      const resp = await fetch(`${GATEWAY_URL}/api/payment/payments/key/${b.id}`, {
        headers: { Authorization: `Bearer ${serviceToken('booking')}` },
        signal: AbortSignal.timeout(3000),
      });
      if (resp.ok) payment = await resp.json();
      else if (resp.status !== 404) continue; // payment service unhealthy — retry next cycle
    } catch {
      continue; // unreachable — retry next cycle
    }

    if (payment && payment.status === 'succeeded') {
      const recovered = await settleBooking(b.id, 'confirmed', payment.paymentId, {
        type: QUEUE,
        payload: {
          bookingId: b.id,
          eventId: b.event_id,
          seatId: b.seat_id,
          seatLabel: b.label,
          userId: b.user_id,
          priceCents: b.price_cents,
          confirmedAt: new Date().toISOString(),
        },
      });
      if (recovered) {
        console.log(`booking: sweep recovered paid booking ${b.id} — confirmed`);
        sweepRecoveriesTotal.inc();
        relayOutbox().catch(() => {});
      }
    } else if (await settleBooking(b.id, 'cancelled', payment ? payment.paymentId : null)) {
      console.log(`booking: sweep cancelled stale pending booking ${b.id}`);
    }
  }
}

function startSweep() {
  sweepTimer = setInterval(() => {
    sweepExpiredPendings().catch((err) => console.error('booking: sweep error:', err.message));
    pruneOutbox();
  }, SWEEP_INTERVAL_MS);
}

// The relay's safety net. The nudge after each confirmation handles the happy
// path; this is what drains the backlog after a broker outage or a crash.
function startOutboxRelay() {
  outboxTimer = setInterval(
    () => relayOutbox().catch((err) => console.error('booking: relay error:', err.message)),
    OUTBOX_INTERVAL_MS
  );
}

// Never gives up: the server keeps confirming bookings while the broker is
// down, so abandoning reconnection would silently drop every future event.
async function connectQueue() {
  for (let attempt = 1; ; attempt++) {
    if (shuttingDown) return;
    let conn = null;
    try {
      conn = await amqp.connect(process.env.RABBITMQ_URL);
      // Attached immediately: an 'error' event with no listener would take the
      // process down before setup finishes.
      conn.on('error', (err) => console.error('booking: RabbitMQ error:', err.message));

      // Confirm channel, not a plain one: the outbox relay must know the broker
      // actually accepted a message before it marks the row published.
      const ch = await conn.createConfirmChannel();
      await ch.assertQueue(QUEUE, { durable: true });

      // Only once the queue is asserted: a failure during setup is retried by
      // this loop, and must not also spawn a second loop from here.
      conn.on('close', () => {
        channel = null;
        if (shuttingDown) return; // we closed it on purpose
        console.error('booking: RabbitMQ connection closed — reconnecting');
        setTimeout(connectQueue, RECONNECT_DELAY_MS);
      });

      // Published to only after assertQueue, so /health never reports 'ok' for
      // a channel that cannot yet accept a booking.confirmed.
      connection = conn;
      channel = ch;
      console.log('booking: connected to RabbitMQ');
      // Anything that piled up while the broker was away goes out now.
      relayOutbox().catch(() => {});
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
  startOutboxRelay();
  server = app.listen(PORT, () => console.log(`booking service listening on :${PORT}`));
}

// Drain in order: stop scheduling sweeps, stop accepting requests and let
// in-flight bookings finish, then release the connections. Cutting a booking
// off mid-payment leaves it pending for the sweep to reconcile — correct, but
// there is no reason to create the work.
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`booking: ${signal} received — draining`);

  // Backstop, so a wedged connection can't hold the container past Docker's
  // SIGKILL deadline. unref'd: it must not itself keep the process alive.
  setTimeout(() => {
    console.error('booking: drain timed out — exiting anyway');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  clearInterval(sweepTimer);
  clearInterval(outboxTimer);
  if (server) {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeIdleConnections(); // keep-alive sockets would otherwise stall close()
    await closed;
  }
  await Promise.allSettled([
    connection && connection.close(),
    redis.isOpen && redis.quit(),
    pool.end(),
  ]);
  console.log('booking: drained');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch((err) => {
  console.error('booking failed to start:', err);
  process.exit(1);
});
