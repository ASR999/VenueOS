// Draining and honest aggregate health. These stop the whole app tier, so they
// run last and put it back afterwards.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

const TIMEOUT = 180000;
const APP_SERVICES = ['gateway', 'catalog', 'booking', 'payment', 'notifications'];

test.before(async () => {
  await h.waitForStack();
});

test('every service drains on SIGTERM instead of being killed', { timeout: TIMEOUT }, async () => {
  h.compose('stop', ...APP_SERVICES);

  try {
    for (const service of APP_SERVICES) {
      const code = h.exitCode(service);
      assert.equal(
        code,
        0,
        `${service} exited ${code} (143 = SIGTERM with no handler, 137 = SIGKILL after the stop timeout, 1 = drain timed out)`
      );
    }
    // No timing assertion needed: exit 0 is only reachable if the handler ran to
    // completion. Being waited out gives 137, and the drain backstop gives 1.
  } finally {
    h.compose('start', ...APP_SERVICES);
  }

  await h.waitForStack();
});

test('aggregate health is 200 only when every dependency is ok', { timeout: TIMEOUT }, async () => {
  const healthy = await h.req('GET', '/health');
  assert.equal(healthy.status, 200);
  assert.equal(healthy.body.status, 'ok');

  h.compose('stop', 'payment');
  try {
    const degraded = await h.req('GET', '/health');
    assert.equal(degraded.status, 503, 'a down dependency must not be reported with a 200');
    assert.equal(degraded.body.status, 'degraded');
    assert.equal(degraded.body.services.payment.status, 'unreachable');
    // The other services still report individually - the aggregate says which.
    assert.equal(degraded.body.services.catalog.status, 'ok');
  } finally {
    h.compose('start', 'payment');
  }

  await h.waitForStack();
  assert.equal((await h.req('GET', '/health')).status, 200);
});

// DESIGN.md's failure-edge table promises 503 (fail closed) when Redis is down.
// It used to hang forever instead: node-redis queues commands while the client
// is disconnected, so the request never returned at all.
test('Redis being down fails holds fast and closed, not 500 and not a hang', { timeout: TIMEOUT }, async () => {
  const { event, seats } = await h.fixture('redis-down');
  const seat = seats[0];

  h.compose('stop', 'redis');
  try {
    const startedAt = Date.now();
    const hold = await h.req('POST', '/api/booking/holds', {
      eventId: event._id,
      seatId: seat.id,
      userId: 'redis-down-user',
    });
    const elapsed = Date.now() - startedAt;

    assert.equal(hold.status, 503, `expected 503, got ${hold.status}: ${hold.text}`);
    assert.ok(elapsed < 5000, `hold took ${elapsed}ms - the request is queueing, not failing fast`);

    // Booking must fail closed too: an unreachable Redis can never be read as
    // "nobody holds this seat".
    const booking = await h.req('POST', '/api/booking/bookings', {
      eventId: event._id,
      seatId: seat.id,
      userId: 'redis-down-user',
    });
    assert.equal(booking.status, 503);

    // ...and booking's own health must admit it.
    assert.equal((await h.serviceHealth('booking')).redis, 'down');
  } finally {
    h.compose('start', 'redis');
  }

  await h.waitForStack();
  const recovered = await h.req('POST', '/api/booking/holds', {
    eventId: event._id,
    seatId: seat.id,
    userId: 'redis-down-user',
  });
  assert.equal(recovered.status, 201, 'holds must work again once Redis is back');
});
