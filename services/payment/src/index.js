const express = require('express');
const { Pool } = require('pg');
const migrate = require('./migrate');

const PORT = process.env.PORT || 4003;
// Must stay under Docker's stop timeout (10s by default) or the container is
// SIGKILLed mid-drain and the whole exercise is pointless.
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '8000', 10);

const app = express();
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let server = null;
let shuttingDown = false;

const ah = (fn) => (req, res, next) => fn(req, res, next).catch(next);

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ service: 'payment', status: 'ok', postgres: 'ok' });
  } catch {
    res.status(503).json({ service: 'payment', status: 'degraded', postgres: 'down' });
  }
});

// Mock payment processor. Idempotent: replaying a request with a known
// idempotency_key returns the original result — never a second charge.
// Callers use their bookingId as the key. Pass simulate: "fail" to test
// the failure path.
app.post(
  '/payments',
  ah(async (req, res) => {
    const { bookingId, amountCents, idempotencyKey, simulate } = req.body || {};
    if (!bookingId || !idempotencyKey || !Number.isInteger(amountCents) || amountCents <= 0) {
      return res
        .status(400)
        .json({ error: 'bookingId, idempotencyKey and positive integer amountCents are required' });
    }

    const status = simulate === 'fail' ? 'failed' : 'succeeded';

    // ON CONFLICT DO NOTHING + fallback SELECT makes concurrent replays safe:
    // exactly one insert wins, everyone reads the same stored outcome.
    const inserted = await pool.query(
      `INSERT INTO payments (idempotency_key, booking_id, amount_cents, status)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id, status`,
      [idempotencyKey, bookingId, amountCents, status]
    );
    if (inserted.rowCount === 1) {
      const p = inserted.rows[0];
      return res.status(201).json({ paymentId: p.id, status: p.status, replay: false });
    }

    const existing = await pool.query(
      'SELECT id, status, booking_id, amount_cents FROM payments WHERE idempotency_key = $1',
      [idempotencyKey]
    );
    const p = existing.rows[0];
    // Stripe-style: a key replay must be the SAME request. Reuse with a
    // different payload is a caller bug — surface it, never mask it.
    if (p.booking_id !== bookingId || p.amount_cents !== amountCents) {
      return res
        .status(409)
        .json({ error: 'idempotency key reused with a different bookingId or amount' });
    }
    res.status(200).json({ paymentId: p.id, status: p.status, replay: true });
  })
);

// Lookup by idempotency key — lets the booking sweep reconcile unknown
// payment outcomes (see DESIGN.md "The reconciling sweep").
app.get(
  '/payments/key/:idempotencyKey',
  ah(async (req, res) => {
    const r = await pool.query(
      'SELECT id, status FROM payments WHERE idempotency_key = $1',
      [req.params.idempotencyKey]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'no payment for this key' });
    res.json({ paymentId: r.rows[0].id, status: r.rows[0].status });
  })
);

app.use((err, req, res, next) => {
  console.error('payment: unhandled error:', err.message);
  res.status(500).json({ error: 'internal error' });
});

async function start() {
  await migrate(pool);
  server = app.listen(PORT, () => console.log(`payment service listening on :${PORT}`));
}

// Stop accepting requests, let in-flight ones finish, then release resources.
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`payment: ${signal} received — draining`);

  // Backstop, so a wedged connection can't hold the container past Docker's
  // SIGKILL deadline. unref'd: it must not itself keep the process alive.
  setTimeout(() => {
    console.error('payment: drain timed out — exiting anyway');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  if (server) {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeIdleConnections(); // keep-alive sockets would otherwise stall close()
    await closed;
  }
  await Promise.allSettled([pool.end()]);
  console.log('payment: drained');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch((err) => {
  console.error('payment failed to start:', err);
  process.exit(1);
});
