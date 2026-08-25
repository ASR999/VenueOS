const express = require('express');
const amqp = require('amqplib');
const { createClient } = require('redis');
const createMetrics = require('./metrics');

const PORT = process.env.PORT || 4004;
const QUEUE = 'booking.confirmed';
const RECONNECT_DELAY_MS = parseInt(process.env.RECONNECT_DELAY_MS || '3000', 10);
// Cap how many unacked messages the broker hands over at once. Without this a
// reconnect after a long outage would push the whole backlog into memory.
const PREFETCH = parseInt(process.env.PREFETCH || '10', 10);
// Must stay under Docker's stop timeout (10s by default) or the container is
// SIGKILLed mid-drain and the whole exercise is pointless.
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '8000', 10);
// How long a bookingId is remembered as "already emailed". Long enough to cover
// any plausible redelivery; not forever, because this is a dedupe window and not
// an archive.
const DEDUPE_TTL_SECONDS = parseInt(process.env.DEDUPE_TTL_SECONDS || '86400', 10);

// The single source of truth for "are we actually consuming?". /health reports
// this rather than a one-way flag, so a connection that drops after startup
// stops claiming to be healthy.
// Redis DB 2 - booking owns 0, catalog owns 1. The consumer needs somewhere
// durable to remember what it has already sent: an in-memory set would forget
// on every restart, which is precisely when redeliveries arrive.
const dedupe = createClient({ url: process.env.DEDUPE_REDIS_URL, disableOfflineQueue: true });
dedupe.on('error', (err) => console.error('notifications: dedupe store error:', err.message));

let channel = null;
let connection = null;
let server = null;
let shuttingDown = false;

const metrics = createMetrics('notifications');
const notificationsTotal = new metrics.client.Counter({
  name: 'tickethub_notifications_total',
  help: 'Consumed booking.confirmed events by outcome',
  labelNames: ['outcome'], // sent | duplicate | unparseable
  registers: [metrics.register],
});

const app = express();
app.use(metrics.middleware);
app.get('/metrics', metrics.handler);

app.get('/health', (req, res) => {
  const ok = channel !== null;
  res
    .status(ok ? 200 : 503)
    .json({
      service: 'notifications',
      status: ok ? 'ok' : 'degraded',
      rabbitmq: ok ? 'ok' : 'down',
      // Reported, but not part of status: dedupe failing open degrades quality
      // (a possible duplicate email), not availability.
      dedupe: dedupe.isReady ? 'ok' : 'down',
    });
});

// The outbox publishes at-least-once: a relay that publishes and then fails to
// mark the row will re-send. So the consumer, not the publisher, is responsible
// for the customer receiving exactly one email.
//
// SET NX is the claim - the same primitive as a seat hold, for the same reason:
// it is atomic, so two consumers racing the same redelivery cannot both win.
async function alreadySent(bookingId) {
  try {
    const claimed = await dedupe.set(`sent:${bookingId}`, '1', {
      NX: true,
      EX: DEDUPE_TTL_SECONDS,
    });
    return claimed !== 'OK';
  } catch (err) {
    // Fail OPEN. A duplicate confirmation email is a nuisance; a missing one is
    // a customer who thinks they have no ticket.
    console.error('notifications: dedupe unavailable, sending anyway:', err.message);
    return false;
  }
}

async function handleMessage(ch, msg) {
  if (!msg) return; // consumer cancelled by the broker
  let data = null;
  try {
    data = JSON.parse(msg.content.toString());
  } catch {
    /* fall through to raw log */
  }

  if (!data || !data.bookingId) {
    // Unparseable and unroutable: ack it rather than let it cycle forever.
    console.log('notifications: unrecognized message:', msg.content.toString());
    notificationsTotal.inc({ outcome: 'unparseable' });
    return ch.ack(msg);
  }

  if (await alreadySent(data.bookingId)) {
    console.log(`notifications: duplicate for booking ${data.bookingId} — already emailed, skipping`);
    notificationsTotal.inc({ outcome: 'duplicate' });
    return ch.ack(msg);
  }

  // Mock email send.
  console.log(
    `notifications: [mock email] to ${data.userId}: seat ${data.seatLabel} confirmed, ` +
      `booking ${data.bookingId} ($${(data.priceCents / 100).toFixed(2)})`
  );
  notificationsTotal.inc({ outcome: 'sent' });
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
      await ch.consume(QUEUE, (msg) =>
        handleMessage(ch, msg).catch((err) =>
          console.error('notifications: handler failed:', err.message)
        )
      );

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
  // Not awaited: dedupe is best-effort, so a slow Redis must not delay consuming.
  dedupe.connect().catch((err) => console.error('notifications: dedupe unavailable:', err.message));
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
  await Promise.allSettled([connection && connection.close(), dedupe.isOpen && dedupe.quit()]);
  console.log('notifications: drained');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();
