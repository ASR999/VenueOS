// Consumer-side idempotency. The outbox publishes at-least-once, so the
// consumer is what stands between a redelivery and a second email.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

const TIMEOUT = 120000;

test.before(async () => {
  await h.waitForStack();
});

test('a redelivered event does not send a second email', { timeout: TIMEOUT }, async () => {
  const { event, seats } = await h.fixture('idempotent-consumer');
  const seat = seats[0];

  await h.req('POST', '/api/booking/holds', { eventId: event._id, seatId: seat.id });
  const booking = await h.req('POST', '/api/booking/bookings', {
    eventId: event._id,
    seatId: seat.id,
  });
  assert.equal(booking.status, 201);
  const { bookingId } = booking.body;

  await h.waitFor(() => h.notificationsLogCount(bookingId) >= 1, {
    label: 'the first email',
    timeoutMs: 20000,
  });
  const afterFirst = h.notificationsLogCount(bookingId);

  // Force the redelivery the outbox can legitimately produce: republish the
  // same event by clearing published_at so the relay sends it again.
  h.compose(
    'exec', '-T', 'postgres', 'psql', '-U', 'dev', '-d', 'booking', '-tAc',
    `UPDATE outbox SET published_at = NULL WHERE aggregate_id = '${bookingId}'`
  );

  await h.waitFor(
    () =>
      h
        .compose('exec', '-T', 'postgres', 'psql', '-U', 'dev', '-d', 'booking', '-tAc',
          `SELECT published_at IS NOT NULL FROM outbox WHERE aggregate_id = '${bookingId}'`)
        .trim() === 't',
    { label: 'the event to be republished', timeoutMs: 30000 }
  );

  await h.sleep(2000); // give a duplicate every chance to appear

  const emails = h
    .compose('logs', 'notifications')
    .split('\n')
    .filter((l) => l.includes(bookingId) && l.includes('[mock email]')).length;
  assert.equal(emails, 1, 'the customer must be emailed exactly once, however often the event arrives');

  const skipped = h
    .compose('logs', 'notifications')
    .split('\n')
    .filter((l) => l.includes(bookingId) && l.includes('already emailed')).length;
  assert.ok(skipped >= 1, 'the duplicate should have been recognised and skipped');
  assert.ok(h.notificationsLogCount(bookingId) > afterFirst, 'the event should have been redelivered at all');
});
