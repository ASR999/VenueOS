// The transactional outbox. This closes the last Phase 1 gap in DESIGN.md: a
// crash between "payment succeeded" and "event published" used to lose the
// event outright.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

const TIMEOUT = 180000;

test.before(async () => {
  await h.waitForStack();
});

function psql(sql) {
  return h
    .compose('exec', '-T', 'postgres', 'psql', '-U', 'dev', '-d', 'booking', '-tAc', sql)
    .trim();
}

async function bookASeat(name) {
  const { event, seats } = await h.fixture(name);
  const seat = seats[0];
  const hold = await h.req('POST', '/api/booking/holds', {
    eventId: event._id,
    seatId: seat.id,
  });
  assert.equal(hold.status, 201);
  const booking = await h.req('POST', '/api/booking/bookings', {
    eventId: event._id,
    seatId: seat.id,
  });
  assert.equal(booking.status, 201, booking.text);
  return booking.body.bookingId;
}

test('confirming a booking writes an outbox row and relays it', { timeout: TIMEOUT }, async () => {
  const bookingId = await bookASeat('outbox-happy');

  const row = await h.waitFor(
    () => {
      // Concatenated rather than two round trips; note psql renders a bool as
      // 'true' once it is cast to text by ||, not the bare 't'.
      const out = psql(
        `SELECT type || '|' || (published_at IS NOT NULL)::text FROM outbox WHERE aggregate_id = '${bookingId}'`
      );
      return out || null;
    },
    { label: 'the outbox row to be written and published', timeoutMs: 20000 }
  );
  assert.equal(row, 'booking.confirmed|true');

  await h.waitFor(() => h.notificationsLogCount(bookingId) >= 1, {
    label: 'the relayed event to be consumed',
    timeoutMs: 20000,
  });
});

// The gap this pattern exists for. With the broker down the booking must still
// confirm, the event must survive in Postgres, and it must go out on reconnect.
test('an event survives the broker being down and is relayed on reconnect', { timeout: TIMEOUT }, async () => {
  h.compose('stop', 'rabbitmq');
  let bookingId;
  try {
    bookingId = await bookASeat('outbox-broker-down');

    // Confirmed in Postgres, with the event durably owed - not lost.
    assert.equal(psql(`SELECT status FROM bookings WHERE id = '${bookingId}'`), 'confirmed');
    assert.equal(
      psql(`SELECT published_at IS NULL FROM outbox WHERE aggregate_id = '${bookingId}'`),
      't',
      'the event should be sitting unpublished in the outbox'
    );
  } finally {
    h.compose('start', 'rabbitmq');
  }

  await h.waitForStack();

  await h.waitFor(
    () => psql(`SELECT published_at IS NOT NULL FROM outbox WHERE aggregate_id = '${bookingId}'`) === 't',
    { label: 'the relay to drain the backlog', timeoutMs: 90000, intervalMs: 500 }
  );
  await h.waitFor(() => h.notificationsLogCount(bookingId) >= 1, {
    label: 'the delayed event to reach the consumer',
    timeoutMs: 30000,
  });
});

test('a cancelled booking produces no event', { timeout: TIMEOUT }, async () => {
  const { event, seats } = await h.fixture('outbox-cancelled');
  const seat = seats[0];

  await h.req('POST', '/api/booking/holds', { eventId: event._id, seatId: seat.id });
  const booking = await h.req('POST', '/api/booking/bookings', {
    eventId: event._id,
    seatId: seat.id,
    simulatePaymentFailure: true,
  });
  assert.equal(booking.status, 402);

  await h.sleep(2000); // let the relay run
  assert.equal(psql(`SELECT count(*) FROM outbox WHERE aggregate_id = '${booking.body.bookingId}'`), '0');
});
