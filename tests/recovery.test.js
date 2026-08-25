// The reconciling sweep, and the rule that makes it work: an ambiguous payment
// response is UNKNOWN, never a rejection. These tests stop the payment
// container, so they must not run alongside the others (see npm test).
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

// Long enough for a container restart; the suite is I/O-bound, not slow.
const TIMEOUT = 120000;

test.before(async () => {
  await h.waitForStack();
});

// Drives a booking into the pending/unknown state by making the payment service
// unreachable, and returns its id. This is the exact shape of the bug that used
// to live here: the gateway answers with a 5xx of its own, which is
// indistinguishable from a clean refusal unless you look at the status class.
async function bookAgainstDeadPayment(name) {
  const { event, seats } = await h.fixture(name);
  const seat = seats[0];
  const userId = `${name}-user`;

  const hold = await h.req('POST', '/api/booking/holds', {
    eventId: event._id,
    seatId: seat.id,
    userId,
  });
  assert.equal(hold.status, 201);

  h.compose('stop', 'payment');
  let booking;
  try {
    booking = await h.req('POST', '/api/booking/bookings', {
      eventId: event._id,
      seatId: seat.id,
      userId,
    });
  } finally {
    h.compose('start', 'payment');
  }

  assert.equal(booking.status, 502, `expected 502 unknown, got ${booking.status}: ${booking.text}`);
  assert.match(booking.body.error, /unknown/, 'the caller must be told the outcome is unknown');

  // Pin the test to the branch it exists to cover. A client-side abort was
  // already handled correctly before the fix; the regression only lives in the
  // path where the gateway actually *answers* with a 5xx.
  assert.ok(
    h.compose('logs', 'booking').includes(`payment outcome unknown for ${booking.body.bookingId}: HTTP 5`),
    'this test must exercise the 5xx-response branch, not the timeout branch'
  );

  // The critical assertion: NOT cancelled. A charge may exist, and only the
  // sweep — which looks at pending rows — is allowed to decide.
  const row = await h.req('GET', `/api/booking/bookings/${booking.body.bookingId}`);
  assert.equal(
    row.body.status,
    'pending',
    'an ambiguous payment response must leave the booking pending, never cancelled'
  );

  // The seat stays protected while the outcome is unknown.
  const [held] = await h.seats(event._id);
  assert.equal(held.status, 'booked');

  await h.waitFor(async () => (await h.req('GET', '/api/payment/health')).status === 200, {
    label: 'payment service back up',
    timeoutMs: 60000,
  });

  return { event, seat, userId, bookingId: booking.body.bookingId };
}

test('unknown payment outcome with no charge: the sweep cancels and frees the seat', { timeout: TIMEOUT }, async () => {
  const { event, bookingId } = await bookAgainstDeadPayment('sweep-cancel');

  const settled = await h.waitFor(
    async () => {
      const r = await h.req('GET', `/api/booking/bookings/${bookingId}`);
      return r.body.status !== 'pending' ? r.body : null;
    },
    { label: 'the sweep to settle the booking', timeoutMs: 60000, intervalMs: 500 }
  );

  assert.equal(settled.status, 'cancelled', 'no charge exists for this key, so the sweep must cancel');

  const [freed] = await h.seats(event._id);
  assert.equal(freed.status, 'available', 'cancelling must return the seat to inventory');
});

// DESIGN.md: "A paid booking is never cancelled by the sweep." This is the
// crash-after-charge edge — the payment exists, the confirm never happened.
test('unknown payment outcome WITH a charge: the sweep confirms, never cancels', { timeout: TIMEOUT }, async () => {
  const { event, seat, bookingId } = await bookAgainstDeadPayment('sweep-recover');

  // Stand in for the charge that went through before the response was lost.
  const charge = await h.req('POST', '/api/payment/payments', {
    bookingId,
    amountCents: seat.priceCents,
    idempotencyKey: bookingId,
  });
  assert.equal(charge.status, 201, `could not record the charge: ${charge.text}`);

  const settled = await h.waitFor(
    async () => {
      const r = await h.req('GET', `/api/booking/bookings/${bookingId}`);
      return r.body.status !== 'pending' ? r.body : null;
    },
    { label: 'the sweep to reconcile against the payment record', timeoutMs: 60000, intervalMs: 500 }
  );

  assert.equal(settled.status, 'confirmed', 'the user paid — the sweep must recover the seat, not cancel it');
  assert.equal(settled.payment_id, charge.body.paymentId);

  const [booked] = await h.seats(event._id);
  assert.equal(booked.status, 'booked');

  // The recovered booking still notifies the user, exactly once.
  await h.waitFor(() => h.notificationsLogCount(bookingId) >= 1, {
    label: 'booking.confirmed from the sweep',
    timeoutMs: 20000,
  });
  await h.sleep(1000);
  assert.equal(h.notificationsLogCount(bookingId), 1);
});
