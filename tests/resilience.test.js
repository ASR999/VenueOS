// Operational behaviour: services must survive their dependencies restarting,
// tell the truth about it while it happens, and come back on their own. These
// restart shared containers, so they run serially and last.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

const TIMEOUT = 180000;

test.before(async () => {
  await h.waitForStack();
});

test('notifications admits the broker is gone, then reconnects in-process', { timeout: TIMEOUT }, async () => {
  assert.equal((await h.serviceHealth('notifications')).status, 'ok');
  const startedAt = h.containerStartedAt('notifications');

  h.compose('restart', 'rabbitmq');

  // The old consumer set a one-way flag at startup and reported 'ok' forever,
  // even holding a dead connection. Health has to track reality.
  await h.waitFor(async () => (await h.serviceHealth('notifications')).status !== 'ok', {
    label: 'notifications to report degraded',
    timeoutMs: 60000,
    intervalMs: 250,
  });

  await h.waitFor(async () => (await h.serviceHealth('notifications')).status === 'ok', {
    label: 'notifications to reconnect',
    timeoutMs: 120000,
    intervalMs: 500,
  });

  // Recovered by its own retry loop, not resurrected by Docker. The old version
  // exited after 10 attempts, which is a materially different thing.
  assert.equal(
    h.containerStartedAt('notifications'),
    startedAt,
    'notifications should have reconnected without the process dying'
  );
});

test('a booking made after a broker outage still reaches the consumer', { timeout: TIMEOUT }, async () => {
  await h.waitForStack();

  const { event, seats } = await h.fixture('post-outage');
  const seat = seats[0];
  const userId = 'post-outage-user';

  const hold = await h.req('POST', '/api/booking/holds', {
    eventId: event._id,
    seatId: seat.id,
    userId,
  });
  assert.equal(hold.status, 201);

  const booking = await h.req('POST', '/api/booking/bookings', {
    eventId: event._id,
    seatId: seat.id,
    userId,
  });
  assert.equal(booking.status, 201, `booking failed after the outage: ${booking.text}`);

  await h.waitFor(() => h.notificationsLogCount(booking.body.bookingId) >= 1, {
    label: 'booking.confirmed to be consumed after the outage',
    timeoutMs: 30000,
  });
});

// restart: unless-stopped on every container. An authentic crash can't be
// simulated from here - PID 1 ignores signals from inside its own namespace,
// and `docker kill` is recorded as a manual stop so the policy is skipped by
// design. So this asserts the policy is actually attached to every container,
// which is the part this repo controls; Docker's own restart semantics are
// Docker's to guarantee.
test('every container carries a restart policy', { timeout: TIMEOUT }, () => {
  const services = [
    'mongo', 'postgres', 'redis', 'rabbitmq',
    'catalog', 'booking', 'payment', 'notifications', 'gateway',
  ];
  for (const service of services) {
    assert.equal(h.restartPolicy(service), 'unless-stopped', `${service} has no restart policy`);
  }
});

test('a deliberately stopped service stays stopped', { timeout: TIMEOUT }, async () => {
  h.compose('stop', 'payment');
  try {
    await h.sleep(5000); // long enough for a restart policy to have fired
    const health = await h.serviceHealth('payment');
    assert.notEqual(health.status, 'ok', 'unless-stopped must not resurrect an explicit stop');
  } finally {
    h.compose('start', 'payment');
  }
  await h.waitForStack();
});
