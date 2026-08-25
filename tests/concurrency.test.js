// The Phase 1 definition of done (DESIGN.md): under N-way contention for one
// seat, exactly one caller wins and exactly one booking exists. If anything
// here flakes even once, the locking design is wrong.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

// Bump via RACERS to crank contention: RACERS=100 npm test
const N = parseInt(process.env.RACERS || '20', 10);

test.before(async () => {
  await h.waitForStack();
});

test('N parallel holds on one seat: Redis NX picks exactly one winner', async () => {
  const { event, seats } = await h.fixture('hold-race');
  const seat = seats[0];

  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      h.req('POST', '/api/booking/holds', {
        eventId: event._id,
        seatId: seat.id,
        userId: `racer-${i}`,
      })
    )
  );

  const won = results.filter((r) => r.status === 201);
  const lost = results.filter((r) => r.status === 409);
  assert.equal(won.length, 1, `expected exactly 1 hold to succeed, got ${won.length}`);
  assert.equal(lost.length, N - 1, `expected ${N - 1} clean 409s, got ${lost.length}`);
  // No other status codes leaked through — every loser got a *clean* rejection.
  assert.equal(won.length + lost.length, N, `unexpected statuses: ${results.map((r) => r.status).join(',')}`);

  const [after] = await h.seats(event._id);
  assert.equal(after.status, 'held');
});

// THE LAW. Every caller here legitimately holds the seat (same userId), so the
// Redis check waves all N through and the Postgres partial unique index is the
// only thing standing between them and a double booking. This is also exactly
// what a retry storm or a lost-hold scenario looks like.
test('N parallel bookings from the hold owner: the unique index admits exactly one', async () => {
  const { event, seats } = await h.fixture('booking-race');
  const seat = seats[0];
  const userId = 'the-holder';

  const hold = await h.req('POST', '/api/booking/holds', {
    eventId: event._id,
    seatId: seat.id,
    userId,
  });
  assert.equal(hold.status, 201);

  const results = await Promise.all(
    Array.from({ length: N }, () =>
      h.req('POST', '/api/booking/bookings', { eventId: event._id, seatId: seat.id, userId })
    )
  );

  const won = results.filter((r) => r.status === 201);
  const lost = results.filter((r) => r.status === 409);
  assert.equal(won.length, 1, `expected exactly 1 booking, got ${won.length}: ${JSON.stringify(results.map((r) => [r.status, r.body]))}`);
  assert.equal(lost.length, N - 1, `expected ${N - 1} clean 409s, got ${lost.length}`);
  for (const r of lost) assert.equal(r.body.error, 'seat already booked');

  const { bookingId } = won[0].body;
  assert.equal(won[0].body.status, 'confirmed');

  const booking = await h.req('GET', `/api/booking/bookings/${bookingId}`);
  assert.equal(booking.status, 200);
  assert.equal(booking.body.status, 'confirmed');
  assert.ok(booking.body.payment_id, 'confirmed booking must carry a payment id');

  const [after] = await h.seats(event._id);
  assert.equal(after.status, 'booked');

  // ...and exactly one booking.confirmed reached the consumer.
  await h.waitFor(() => h.notificationsLogCount(bookingId) >= 1, {
    label: 'booking.confirmed to be consumed',
    timeoutMs: 15000,
  });
  await h.sleep(1000); // give any duplicate a chance to show up before counting
  assert.equal(
    h.notificationsLogCount(bookingId),
    1,
    'booking.confirmed must be published exactly once'
  );
});

// Contention across *different* seats must not serialise or cross-talk: 8 users
// each grabbing their own seat should all succeed.
test('parallel bookings on distinct seats all succeed', async () => {
  const seatCount = 8;
  const { event, seats } = await h.fixture('parallel-seats', seatCount);
  assert.equal(seats.length, seatCount);

  const results = await Promise.all(
    seats.map(async (seat, i) => {
      const userId = `buyer-${i}`;
      const hold = await h.req('POST', '/api/booking/holds', {
        eventId: event._id,
        seatId: seat.id,
        userId,
      });
      assert.equal(hold.status, 201, `hold for ${seat.label} failed: ${JSON.stringify(hold.body)}`);
      return h.req('POST', '/api/booking/bookings', { eventId: event._id, seatId: seat.id, userId });
    })
  );

  assert.equal(results.filter((r) => r.status === 201).length, seatCount);
  const after = await h.seats(event._id);
  assert.ok(after.every((s) => s.status === 'booked'), 'every seat should end up booked');
});
