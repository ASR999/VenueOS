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

  // Real, distinct identities. Sharing one token would test a user racing
  // themselves, which the hold endpoint deliberately treats as a double-click
  // and answers 200 - the opposite of contention.
  const racers = await Promise.all(Array.from({ length: N }, (_, i) => h.signup(`racer${i}`)));

  const results = await Promise.all(
    racers.map((racer) =>
      h.req(
        'POST',
        '/api/booking/holds',
        { eventId: event._id, seatId: seat.id },
        { token: racer.token }
      )
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

// THE LAW. Every caller here is the same authenticated user and legitimately
// holds the seat, so the
// Redis check waves all N through and the Postgres partial unique index is the
// only thing standing between them and a double booking. This is also exactly
// what a retry storm or a lost-hold scenario looks like.
test('N parallel bookings from the hold owner: the unique index admits exactly one', async () => {
  const { event, seats } = await h.fixture('booking-race');
  const seat = seats[0];

  // One identity on purpose: this is the retry-storm shape, where every request
  // legitimately holds the seat and only the unique index can arbitrate.
  const holder = await h.signup('the-holder');
  const hold = await h.req(
    'POST',
    '/api/booking/holds',
    { eventId: event._id, seatId: seat.id },
    { token: holder.token }
  );
  assert.equal(hold.status, 201);

  const results = await Promise.all(
    Array.from({ length: N }, () =>
      h.req(
        'POST',
        '/api/booking/bookings',
        { eventId: event._id, seatId: seat.id },
        { token: holder.token }
      )
    )
  );

  const won = results.filter((r) => r.status === 201);
  const lost = results.filter((r) => r.status === 409);
  assert.equal(won.length, 1, `expected exactly 1 booking, got ${won.length}: ${JSON.stringify(results.map((r) => [r.status, r.body]))}`);
  assert.equal(lost.length, N - 1, `expected ${N - 1} clean 409s, got ${lost.length}`);

  // Two rejection reasons are legitimate here and which one you get is a race:
  // the winner releases its hold once confirmed, so a request that arrives after
  // that is turned away by the hold check instead of the unique index. Both are
  // clean 409s. Asserting only one of them made this test quietly
  // timing-dependent; the invariant below is what actually matters.
  const cleanRejections = ['seat already booked', 'you must hold the seat before booking'];
  for (const r of lost) {
    assert.ok(
      cleanRejections.includes(r.body.error),
      `unexpected rejection reason: ${JSON.stringify(r.body)}`
    );
  }

  // THE LAW itself, read from the source of truth and free of timing: however
  // the 19 losers were turned away, the seat may carry exactly one live booking.
  const activeRows = h
    .compose('exec', '-T', 'postgres', 'psql', '-U', 'dev', '-d', 'booking', '-tAc',
      `SELECT count(*) FROM bookings WHERE seat_id = '${seat.id}' AND status <> 'cancelled'`)
    .trim();
  assert.equal(activeRows, '1', 'exactly one active booking may exist for a seat');

  const { bookingId } = won[0].body;
  assert.equal(won[0].body.status, 'confirmed');

  const booking = await h.req('GET', `/api/booking/bookings/${bookingId}`, undefined, {
    token: holder.token,
  });
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

  const buyers = await Promise.all(seats.map((_, i) => h.signup(`buyer${i}`)));

  const results = await Promise.all(
    seats.map(async (seat, i) => {
      const token = buyers[i].token;
      const hold = await h.req(
        'POST',
        '/api/booking/holds',
        { eventId: event._id, seatId: seat.id },
        { token }
      );
      assert.equal(hold.status, 201, `hold for ${seat.label} failed: ${JSON.stringify(hold.body)}`);
      return h.req(
        'POST',
        '/api/booking/bookings',
        { eventId: event._id, seatId: seat.id },
        { token }
      );
    })
  );

  assert.equal(results.filter((r) => r.status === 201).length, seatCount);
  const after = await h.seats(event._id);
  assert.ok(after.every((s) => s.status === 'booked'), 'every seat should end up booked');
});
