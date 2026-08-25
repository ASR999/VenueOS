// Authentication, and the authorization it makes possible. Before this existed,
// `userId` was a string in the request body: anyone could hold, book, or read
// bookings as anyone else simply by typing their id.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

const TIMEOUT = 120000;
const PASSWORD = 'correct-horse-battery';

test.before(async () => {
  await h.waitForStack();
});

const anon = (method, path, body) => h.req(method, path, body, { token: null });

test('signup issues a token; the same email cannot register twice', { timeout: TIMEOUT }, async () => {
  const email = `dup-${Date.now()}@example.test`;

  const first = await anon('POST', '/api/auth/signup', { email, password: PASSWORD });
  assert.equal(first.status, 201);
  assert.ok(first.body.token, 'signup should return a token');
  assert.equal(first.body.user.email, email);
  assert.ok(!('password' in first.body.user), 'never echo the password back');
  assert.ok(!('password_hash' in first.body.user), 'never expose the hash');

  const again = await anon('POST', '/api/auth/signup', { email, password: PASSWORD });
  assert.equal(again.status, 409);

  // Case differences are the same human, not a second account.
  const upper = await anon('POST', '/api/auth/signup', {
    email: email.toUpperCase(),
    password: PASSWORD,
  });
  assert.equal(upper.status, 409, 'email uniqueness must be case-insensitive');
});

test('login works, and rejects a wrong password', { timeout: TIMEOUT }, async () => {
  const email = `login-${Date.now()}@example.test`;
  await anon('POST', '/api/auth/signup', { email, password: PASSWORD });

  const good = await anon('POST', '/api/auth/login', { email, password: PASSWORD });
  assert.equal(good.status, 200);
  assert.ok(good.body.token);

  const bad = await anon('POST', '/api/auth/login', { email, password: 'wrong-horse-battery' });
  assert.equal(bad.status, 401);

  // Same response for an unknown account, or the login form becomes an
  // account-enumeration oracle.
  const missing = await anon('POST', '/api/auth/login', {
    email: `nobody-${Date.now()}@example.test`,
    password: PASSWORD,
  });
  assert.equal(missing.status, 401);
  assert.deepEqual(
    missing.body,
    bad.body,
    'unknown user and wrong password must be indistinguishable'
  );
});

test('weak or malformed credentials are refused', { timeout: TIMEOUT }, async () => {
  const short = await anon('POST', '/api/auth/signup', {
    email: `w-${Date.now()}@example.test`,
    password: 'short',
  });
  assert.equal(short.status, 400);

  const notEmail = await anon('POST', '/api/auth/signup', {
    email: 'not-an-email',
    password: PASSWORD,
  });
  assert.equal(notEmail.status, 400);
});

test('booking endpoints reject anonymous callers', { timeout: TIMEOUT }, async () => {
  const { event, seats } = await h.fixture('auth-anon');
  const seat = seats[0];
  const body = { eventId: event._id, seatId: seat.id };

  const guarded = [
    ['POST', '/api/booking/holds', body],
    ['DELETE', '/api/booking/holds', body],
    ['POST', '/api/booking/bookings', body],
    ['GET', '/api/booking/bookings', undefined],
  ];
  for (const [method, path, payload] of guarded) {
    const res = await anon(method, path, payload);
    assert.equal(res.status, 401, `${method} ${path} should require authentication`);
  }

  // Browsing stays open: you should not need an account to see what is on sale.
  assert.equal((await anon('GET', `/api/booking/events/${event._id}/seats`)).status, 200);
  assert.equal((await anon('GET', '/api/catalog/events')).status, 200);
});

test('a forged or tampered token is rejected', { timeout: TIMEOUT }, async () => {
  const user = await h.signup('tamper');
  const [header, payload, signature] = user.token.split('.');

  // Same claims, broken signature. This is the whole reason each service
  // verifies rather than trusting a header someone else set.
  const forged = `${header}.${payload}.${signature.slice(0, -4)}AAAA`;
  assert.equal((await h.req('GET', '/api/booking/bookings', undefined, { token: forged })).status, 401);
  assert.equal(
    (await h.req('GET', '/api/booking/bookings', undefined, { token: 'not-a-jwt' })).status,
    401
  );
});

test('one user cannot act on another user seat or booking', { timeout: TIMEOUT }, async () => {
  const owner = await h.signup('owner');
  const attacker = await h.signup('attacker');
  const { event, seats } = await h.fixture('auth-isolation');
  const body = { eventId: event._id, seatId: seats[0].id };

  assert.equal((await h.req('POST', '/api/booking/holds', body, { token: owner.token })).status, 201);

  // Cannot steal the hold...
  assert.equal(
    (await h.req('POST', '/api/booking/holds', body, { token: attacker.token })).status,
    409
  );
  // ...nor release it out from under them...
  assert.equal(
    (await h.req('DELETE', '/api/booking/holds', body, { token: attacker.token })).status,
    403
  );
  // ...nor book the seat they are holding.
  assert.equal(
    (await h.req('POST', '/api/booking/bookings', body, { token: attacker.token })).status,
    409
  );

  const booking = await h.req('POST', '/api/booking/bookings', body, { token: owner.token });
  assert.equal(booking.status, 201);

  // Someone else's booking is not merely forbidden, it is invisible: a 403
  // would confirm the id is real.
  const path = `/api/booking/bookings/${booking.body.bookingId}`;
  assert.equal((await h.req('GET', path, undefined, { token: attacker.token })).status, 404);
  assert.equal((await h.req('GET', path, undefined, { token: owner.token })).status, 200);
});

test('my bookings lists only my own', { timeout: TIMEOUT }, async () => {
  const me = await h.signup('mine');
  const other = await h.signup('theirs');
  const { event, seats } = await h.fixture('auth-my-bookings', 2);

  const book = async (seat, token) => {
    await h.req('POST', '/api/booking/holds', { eventId: event._id, seatId: seat.id }, { token });
    return h.req('POST', '/api/booking/bookings', { eventId: event._id, seatId: seat.id }, { token });
  };
  const a = await book(seats[0], me.token);
  const b = await book(seats[1], other.token);
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);

  const list = await h.req('GET', '/api/booking/bookings', undefined, { token: me.token });
  assert.equal(list.status, 200);
  const ids = list.body.bookings.map((x) => x.id);
  assert.ok(ids.includes(a.body.bookingId), 'my own booking should be listed');
  assert.ok(!ids.includes(b.body.bookingId), 'another user booking must never appear');
  assert.ok(list.body.bookings.every((x) => x.seat_label), 'listing should carry enough to display');
});

test('payment is not open to the public', { timeout: TIMEOUT }, async () => {
  // Reachable through the gateway by design, since booking calls it that way -
  // so it has to authenticate callers itself.
  const probe = { bookingId: 'x', amountCents: 100, idempotencyKey: `probe-${Date.now()}` };
  assert.equal(
    (await anon('POST', '/api/payment/payments', probe)).status,
    401,
    'anyone could otherwise mint payment records'
  );

  // A user token is not a service token: being logged in is not authority to charge.
  const user = await h.signup('not-a-service');
  const asUser = await h.req(
    'POST',
    '/api/payment/payments',
    { ...probe, idempotencyKey: `probe2-${Date.now()}` },
    { token: user.token }
  );
  assert.equal(asUser.status, 403);
});

test('creating an event requires an account, reading does not', { timeout: TIMEOUT }, async () => {
  assert.equal((await anon('POST', '/api/catalog/events', { name: 'Anonymous gig' })).status, 401);
  const signedIn = await h.req('POST', '/api/catalog/events', {
    name: `Signed-in gig ${Date.now()}`,
  });
  assert.equal(signedIn.status, 201);
});
