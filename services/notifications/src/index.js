const express = require('express');
const amqp = require('amqplib');

const PORT = process.env.PORT || 4004;
const QUEUE = 'booking.confirmed';
const RECONNECT_DELAY_MS = parseInt(process.env.RECONNECT_DELAY_MS || '3000', 10);
// Cap how many unacked messages the broker hands over at once. Without this a
// reconnect after a long outage would push the whole backlog into memory.
const PREFETCH = parseInt(process.env.PREFETCH || '10', 10);
// Must stay under Docker's stop timeout (10s by default) or the container is
// SIGKILLed mid-drain and the whole exercise is pointless.
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '8000', 10);

// The single source of truth for "are we actually consuming?". /health reports
// this rather than a one-way flag, so a connection that drops after startup
// stops claiming to be healthy.
let channel = null;
let connection = null;
let server = null;
let shuttingDown = false;

const app = express();

app.get('/health', (req, res) => {
  const ok = channel !== null;
  res
    .status(ok ? 200 : 503)
    .json({ service: 'notifications', status: ok ? 'ok' : 'degraded', rabbitmq: ok ? 'ok' : 'down' });
});

function handleMessage(ch, msg) {
  if (!msg) return; // consumer cancelled by the broker
  // Mock email send. Consumer-side idempotency (dedupe on bookingId) is
  // formalized in Phase 3.
  let data = null;
  try {
    data = JSON.parse(msg.content.toString());
  } catch {
    /* fall through to raw log */
  }
  if (data && data.bookingId) {
    console.log(
      `notifications: [mock email] to ${data.userId}: seat ${data.seatLabel} confirmed, ` +
        `booking ${data.bookingId} ($${(data.priceCents / 100).toFixed(2)})`
    );
  } else {
    console.log('notifications: unrecognized message:', msg.content.toString());
  }
  ch.ack(msg);
}

// Never gives up. Booking keeps confirming bookings while the broker is down,
// so a consumer that exited after N attempts would silently strand every event
// published from then on.
async function connectQueue() {
  for (let attempt = 1; ; attempt++) {
    if (shuttingDown) return;
    let conn = null;
    try {
      conn = await amqp.connect(process.env.RABBITMQ_URL);
      // Attached immediately: an 'error' event with no listener would take the
      // process down before setup finishes.
      conn.on('error', (err) => console.error('notifications: RabbitMQ error:', err.message));

      const ch = await conn.createChannel();
      await ch.assertQueue(QUEUE, { durable: true });
      await ch.prefetch(PREFETCH);
      await ch.consume(QUEUE, (msg) => handleMessage(ch, msg));

      // Only once the consumer is genuinely running: a failure during setup is
      // retried by this loop, and must not also spawn a second loop from here.
      conn.on('close', () => {
        channel = null;
        if (shuttingDown) return; // we closed it on purpose
        console.error('notifications: RabbitMQ connection closed — reconnecting');
        setTimeout(connectQueue, RECONNECT_DELAY_MS);
      });

      connection = conn;
      channel = ch;
      console.log(`notifications: consuming from "${QUEUE}"`);
      return;
    } catch (err) {
      if (conn) await conn.close().catch(() => {});
      if (attempt === 1 || attempt % 10 === 0) {
        console.log(
          `notifications: RabbitMQ not ready (attempt ${attempt}), retrying in ${RECONNECT_DELAY_MS}ms`
        );
      }
      await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));
    }
  }
}

function start() {
  // Listen first so /health can report "degraded" while the broker is still
  // coming up, instead of refusing connections.
  server = app.listen(PORT, () => console.log(`notifications service listening on :${PORT}`));
  connectQueue();
}

// Stop consuming, then release the connection. Unacked messages go back on the
// queue for the next consumer — nothing in flight is lost.
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`notifications: ${signal} received — draining`);

  // Backstop, so a wedged connection can't hold the container past Docker's
  // SIGKILL deadline. unref'd: it must not itself keep the process alive.
  setTimeout(() => {
    console.error('notifications: drain timed out — exiting anyway');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  if (server) {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeIdleConnections(); // keep-alive sockets would otherwise stall close()
    await closed;
  }
  await Promise.allSettled([connection && connection.close()]);
  console.log('notifications: drained');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();
