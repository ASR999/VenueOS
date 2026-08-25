// The gateway rate limiter. Named to sort last: tripping the limit consumes the
// window, so this must not run before tests that make normal requests.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

const TIMEOUT = 180000;
// Matches docker-compose.test.yml. The suite's own bursts stay well under this.
const LIMIT = 500;
const WINDOW_MS = 10000;

test.before(async () => {
  await h.waitForStack();
});

test('bursting past the limit gets 429s, and the window clears', { timeout: TIMEOUT }, async () => {
  // Fire more than 2x the limit. MemoryStore is a FIXED window, so a burst can
  // straddle a rollover and split in two; at 2x+ the limit, no split can leave
  // both halves under it. Batched rather than all at once, so this tests the
  // limiter and not the machine's file descriptors.
  const statuses = [];
  for (let batch = 0; batch < 12; batch++) {
    const results = await Promise.all(
      Array.from({ length: 100 }, () => h.req('GET', '/api/catalog/events'))
    );
    statuses.push(...results.map((r) => r.status));
    if (statuses.filter((s) => s === 429).length > 20) break; // limit is clearly working
  }

  const allowed = statuses.filter((s) => s === 200).length;
  const throttled = statuses.filter((s) => s === 429).length;
  assert.ok(throttled > 0, `expected some 429s after ${statuses.length} requests, got none`);
  // 2x the limit, not 1x: a fixed window that rolls over mid-burst legitimately
  // admits a fresh allowance.
  assert.ok(allowed <= LIMIT * 2, `limiter let ${allowed} through, over two full windows' worth`);
  assert.equal(allowed + throttled, statuses.length, 'unexpected statuses from the limiter');

  // The limit must be a window, not a latch.
  await h.sleep(WINDOW_MS + 1000);
  const after = await h.req('GET', '/api/catalog/events');
  assert.equal(after.status, 200, 'requests should be accepted again once the window rolls over');
});

test('health is never rate limited', { timeout: TIMEOUT }, async () => {
  // Registered ahead of the limiter on purpose: throttling monitoring blinds you
  // exactly when you most need to look.
  const results = await Promise.all(Array.from({ length: 300 }, () => h.req('GET', '/health')));
  assert.ok(
    results.every((r) => r.status === 200 || r.status === 503),
    'health must answer even under a burst that would trip the limiter'
  );
  assert.equal(results.filter((r) => r.status === 429).length, 0);

  await h.sleep(WINDOW_MS + 1000); // leave a clean window for anything after
});
