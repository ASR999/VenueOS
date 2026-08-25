// The payment paths that DESIGN.md makes promises about: a definite rejection
// frees the seat, and an idempotency key can never be charged twice.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

test.before(async () => {
  await h.waitForStack();
});

// Payment authenticates its callers, and a user token is not enough - only
// another service may charge. These tests stand in for booking.
const asService = (method, path, body) =>
  h.req(method, path, body, { token: h.serviceToken('test-harness') });

test('rejected payment cancels the booking and frees the seat for someone else', async () => {
  const { event, seats } = await h.fixture('payment-failure');
  const seat = seats[0];

  const unlucky = await h.signup('unlucky');
  const hold = await h.req(
    'POST',
    '/api/booking/holds',
    { eventId: event._id, seatId: seat.id },
    { token: unlucky.token }
  );
  assert.equal(hold.status, 201);

  const booking = await h.req(
    'POST',
    '/api/booking/bookings',
    { eventId: event._id, seatId: seat.id, simulatePaymentFailure: true },
    { token: unlucky.token }
  );
  assert.equal(booking.status, 402);
  assert.equal(booking.body.error, 'payment failed');

  const row = await h.req('GET', `/api/booking/bookings/${booking.body.bookingId}`, undefined, {
    token: unlucky.token,
  });
  assert.equal(row.body.status, 'cancelled');

  // The seat must be genuinely reusable — the partial index has to let a second
  // active booking exist once the first is cancelled.
  const [freed] = await h.seats(event._id);
  assert.equal(freed.status, 'available');

  // A different person entirely - the seat has to be genuinely free, not just
  // free to whoever cancelled it.
  const luckier = await h.signup('luckier');
  const hold2 = await h.req(
    'POST',
    '/api/booking/holds',
    { eventId: event._id, seatId: seat.id },
    { token: luckier.token }
  );
  assert.equal(hold2.status, 201);
  const booking2 = await h.req(
    'POST',
    '/api/booking/bookings',
    { eventId: event._id, seatId: seat.id },
    { token: luckier.token }
  );
  assert.equal(booking2.status, 201, `rebooking a freed seat failed: ${JSON.stringify(booking2.body)}`);
  assert.equal(booking2.body.status, 'confirmed');
});

test('replaying an idempotency key returns the original charge, never a second one', async () => {
  const key = `idem-${Date.now()}`;
  const payload = { bookingId: key, amountCents: 4200, idempotencyKey: key };

  const first = await asService('POST', '/api/payment/payments', payload);
  assert.equal(first.status, 201);
  assert.equal(first.body.replay, false);
  assert.equal(first.body.status, 'succeeded');

  const replay = await asService('POST', '/api/payment/payments', payload);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replay, true);
  assert.equal(replay.body.paymentId, first.body.paymentId, 'a replay must return the SAME payment');
});

test('concurrent replays of one key still produce a single payment', async () => {
  const key = `idem-race-${Date.now()}`;
  const payload = { bookingId: key, amountCents: 1500, idempotencyKey: key };

  const results = await Promise.all(Array.from({ length: 10 }, () => asService('POST', '/api/payment/payments', payload)));

  const ids = new Set(results.map((r) => r.body.paymentId));
  assert.equal(ids.size, 1, `expected one payment id across concurrent replays, got ${[...ids].join(',')}`);
  assert.equal(results.filter((r) => r.status === 201).length, 1, 'exactly one caller should have created the charge');
});

test('reusing a key with a different amount is rejected, not silently masked', async () => {
  const key = `idem-mismatch-${Date.now()}`;
  const first = await asService('POST', '/api/payment/payments', {
    bookingId: key,
    amountCents: 1000,
    idempotencyKey: key,
  });
  assert.equal(first.status, 201);

  const mismatch = await asService('POST', '/api/payment/payments', {
    bookingId: key,
    amountCents: 9999,
    idempotencyKey: key,
  });
  assert.equal(mismatch.status, 409);
});

test('a payment key with no charge is a clean 404 (what the sweep relies on)', async () => {
  const { status } = await asService('GET', `/api/payment/payments/key/never-charged-${Date.now()}`);
  assert.equal(status, 404);
});
