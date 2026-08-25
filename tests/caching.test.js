// Catalog's cache-aside layer. The contract that matters: it must speed reads up
// without ever becoming a thing that can take the service down.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

const TIMEOUT = 120000;
const CACHE_TTL_MS = 5000; // matches docker-compose.test.yml

test.before(async () => {
  await h.waitForStack();
});

async function getWithCacheHeader(path) {
  const res = await fetch(`${h.GATEWAY}${path}`);
  return { status: res.status, cache: res.headers.get('x-cache'), body: await res.json() };
}

test('a repeated event read is served from cache', { timeout: TIMEOUT }, async () => {
  const event = await h.createEvent('cache-read');

  const first = await getWithCacheHeader(`/api/catalog/events/${event._id}`);
  assert.equal(first.status, 200);
  assert.equal(first.cache, 'MISS');

  const second = await getWithCacheHeader(`/api/catalog/events/${event._id}`);
  assert.equal(second.cache, 'HIT');
  // A HIT and a MISS must be the same bytes, or the cache is changing behaviour.
  assert.deepEqual(second.body, first.body);
});

test('creating an event invalidates the list rather than waiting out the TTL', { timeout: TIMEOUT }, async () => {
  await getWithCacheHeader('/api/catalog/events'); // warm it
  const warmed = await getWithCacheHeader('/api/catalog/events');
  assert.equal(warmed.cache, 'HIT');

  const created = await h.createEvent('cache-invalidation');

  const afterWrite = await getWithCacheHeader('/api/catalog/events');
  assert.equal(afterWrite.cache, 'MISS', 'a write must invalidate the cached list');
  // The list is capped at 50 and sorted by startsAt, so assert on freshness
  // rather than assuming the new event is visible in the window.
  assert.equal(afterWrite.status, 200);

  const direct = await getWithCacheHeader(`/api/catalog/events/${created._id}`);
  assert.equal(direct.status, 200);
  assert.equal(direct.body.name, created.name);
});

test('cached entries expire', { timeout: TIMEOUT }, async () => {
  const event = await h.createEvent('cache-ttl');
  await getWithCacheHeader(`/api/catalog/events/${event._id}`);
  assert.equal((await getWithCacheHeader(`/api/catalog/events/${event._id}`)).cache, 'HIT');

  await h.sleep(CACHE_TTL_MS + 1500);
  assert.equal(
    (await getWithCacheHeader(`/api/catalog/events/${event._id}`)).cache,
    'MISS',
    'the entry should have expired'
  );
});

// The important one. Booking's Redis is load-bearing and fails closed (503);
// catalog's is a cache and must fail OPEN, or adding a cache made the system
// less available than it was without one.
test('catalog keeps serving when the cache is gone', { timeout: TIMEOUT }, async () => {
  const event = await h.createEvent('cache-down');

  h.compose('stop', 'redis');
  try {
    const read = await getWithCacheHeader(`/api/catalog/events/${event._id}`);
    assert.equal(read.status, 200, 'a dead cache must not break reads');
    assert.equal(read.cache, 'BYPASS');
    assert.equal(read.body.name, event.name);

    const list = await getWithCacheHeader('/api/catalog/events');
    assert.equal(list.status, 200);

    // Writes must survive a failed invalidation too.
    const created = await h.createEvent('cache-down-write');
    assert.ok(created._id);

    // Health reports the cache as down, but catalog itself stays ok - the cache
    // is optional, so it must not drag the service's status with it.
    const health = await h.serviceHealth('catalog');
    assert.equal(health.cache, 'down');
    assert.equal(health.status, 'ok');
  } finally {
    h.compose('start', 'redis');
  }

  await h.waitForStack();
  // Leave the world as we found it. Without this the next test inherits a
  // still-reconnecting cache and sees BYPASS where it expects HIT - which is
  // exactly how this failed on CI and passed locally.
  await h.waitForCache();
  assert.equal((await getWithCacheHeader(`/api/catalog/events/${event._id}`)).status, 200);
});

test('search finds events by name, venue and description', { timeout: TIMEOUT }, async () => {
  const marker = `zephyr${Date.now()}`;
  const target = await h.createEvent(`${marker} Jazz Night`);
  await h.createEvent('Unrelated Rock Show');

  const found = await h.waitFor(
    async () => {
      const res = await getWithCacheHeader(`/api/catalog/events?q=${marker}`);
      return res.body.length > 0 ? res : null;
    },
    { label: 'the text index to return the new event', timeoutMs: 15000 }
  );

  assert.equal(found.status, 200);
  assert.equal(found.body.length, 1, 'only the matching event should come back');
  assert.equal(found.body[0]._id, target._id);
  // Search results are not cached - the key would be attacker-controlled.
  assert.equal(found.cache, 'BYPASS');

  const miss = await getWithCacheHeader('/api/catalog/events?q=nothingmatchesthisstring');
  assert.equal(miss.status, 200);
  assert.deepEqual(miss.body, []);
});

test('an empty q falls back to the cached list', { timeout: TIMEOUT }, async () => {
  // Establish the precondition rather than assume it: with no cache, BYPASS is
  // the correct answer and this test would be asserting the wrong thing.
  await h.waitForCache();
  await getWithCacheHeader('/api/catalog/events?q=');
  const again = await getWithCacheHeader('/api/catalog/events?q=');
  assert.equal(again.cache, 'HIT', 'a blank query is the plain list, and should still be cached');
});
