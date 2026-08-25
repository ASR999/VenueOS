// Instrumentation. Scraped straight from each service's published port, the way
// Prometheus does - no Prometheus or Grafana container required.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

const TIMEOUT = 120000;

const SERVICES = {
  gateway: 8080,
  catalog: 4001,
  booking: 4002,
  payment: 4003,
  notifications: 4004,
};

test.before(async () => {
  await h.waitForStack();
});

async function scrape(port) {
  const res = await fetch(`http://localhost:${port}/metrics`);
  return { status: res.status, type: res.headers.get('content-type'), body: await res.text() };
}

// Parses `name{labels} value` for one series.
function value(body, name, labels = '') {
  const needle = labels ? `${name}{` : name;
  for (const line of body.split('\n')) {
    if (line.startsWith('#') || !line.startsWith(needle)) continue;
    if (labels && !labels.split(',').every((l) => line.includes(l))) continue;
    const parsed = Number(line.trim().split(/\s+/).pop());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

test('every service exposes Prometheus metrics', { timeout: TIMEOUT }, async () => {
  for (const [name, port] of Object.entries(SERVICES)) {
    const m = await scrape(port);
    assert.equal(m.status, 200, `${name} /metrics returned ${m.status}`);
    assert.match(m.type, /text\/plain/, `${name} served the wrong content type`);
    assert.match(m.body, /process_cpu_seconds_total/, `${name} is missing default process metrics`);
    assert.match(m.body, /http_request_duration_seconds/, `${name} is missing HTTP metrics`);
    assert.ok(m.body.includes(`service="${name}"`), `${name} is missing its service label`);
  }
});

// The cardinality trap: a UUID in a label mints a series per booking.
test('route labels are patterns, never raw ids', { timeout: TIMEOUT }, async () => {
  const { event, seats } = await h.fixture('metrics-cardinality');
  const seat = seats[0];
  const userId = 'metrics-user';
  await h.req('POST', '/api/booking/holds', { eventId: event._id, seatId: seat.id, userId });
  const booking = await h.req('POST', '/api/booking/bookings', {
    eventId: event._id,
    seatId: seat.id,
    userId,
  });
  await h.req('GET', `/api/booking/bookings/${booking.body.bookingId}`);

  const m = await scrape(SERVICES.booking);
  assert.ok(m.body.includes('route="/bookings/:id"'), 'the route pattern should be the label');
  assert.ok(
    !m.body.includes(booking.body.bookingId),
    'a booking id must never appear in a metric label'
  );
  assert.ok(!m.body.includes(seat.id), 'a seat id must never appear in a metric label');
});

test('booking and hold outcomes are counted', { timeout: TIMEOUT }, async () => {
  const before = await scrape(SERVICES.booking);
  const confirmedBefore = value(before.body, 'tickethub_bookings_total', 'status="confirmed"') || 0;
  const lostBefore = value(before.body, 'tickethub_holds_total', 'outcome="lost"') || 0;

  const { event, seats } = await h.fixture('metrics-counters');
  const seat = seats[0];
  await h.req('POST', '/api/booking/holds', { eventId: event._id, seatId: seat.id, userId: 'winner' });
  // A second user loses the race for the same seat.
  const loser = await h.req('POST', '/api/booking/holds', {
    eventId: event._id,
    seatId: seat.id,
    userId: 'loser',
  });
  assert.equal(loser.status, 409);
  const booking = await h.req('POST', '/api/booking/bookings', {
    eventId: event._id,
    seatId: seat.id,
    userId: 'winner',
  });
  assert.equal(booking.status, 201);

  const after = await scrape(SERVICES.booking);
  assert.equal(
    value(after.body, 'tickethub_bookings_total', 'status="confirmed"'),
    confirmedBefore + 1
  );
  assert.equal(value(after.body, 'tickethub_holds_total', 'outcome="lost"'), lostBefore + 1);
});

test('outbox backlog is reported as a gauge', { timeout: TIMEOUT }, async () => {
  const m = await scrape(SERVICES.booking);
  const backlog = value(m.body, 'tickethub_outbox_backlog');
  assert.ok(Number.isFinite(backlog), 'the backlog gauge should be present');
  assert.ok(backlog >= 0);
});

test('the cache counter tracks hits and misses', { timeout: TIMEOUT }, async () => {
  const before = value((await scrape(SERVICES.catalog)).body, 'tickethub_cache_total', 'result="hit"') || 0;
  await fetch(`${h.GATEWAY}/api/catalog/events`); // warm
  await fetch(`${h.GATEWAY}/api/catalog/events`); // hit
  const after = value((await scrape(SERVICES.catalog)).body, 'tickethub_cache_total', 'result="hit"');
  assert.ok(after > before, 'a repeated read should register a cache hit');
});

// Metrics describe internals. They should not be reachable from outside.
test('metrics are not exposed through the public gateway', { timeout: TIMEOUT }, async () => {
  for (const name of ['booking', 'catalog', 'payment']) {
    const res = await h.req('GET', `/api/${name}/metrics`);
    assert.equal(res.status, 404, `/api/${name}/metrics should not be routable`);
    assert.ok(!res.text.includes('process_cpu_seconds_total'), 'metrics leaked through the gateway');
  }
  // The gateway's own metrics stay available on its port for Prometheus.
  assert.equal((await scrape(SERVICES.gateway)).status, 200);
});
