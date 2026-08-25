// The event listing. Found by clicking through the UI: a real event was missing
// from the list entirely, because 50 tomorrow-dated test events filled the cap
// ahead of it and the endpoint returned 200 with no sign anything was dropped.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

const TIMEOUT = 120000;
const DEFAULT_LIMIT = 20;

test.before(async () => {
  await h.waitForStack();
});

async function list(query = '') {
  const res = await fetch(`${h.GATEWAY}/api/catalog/events${query}`);
  return {
    status: res.status,
    total: Number(res.headers.get('x-total-count')),
    cache: res.headers.get('x-cache'),
    body: await res.json(),
  };
}

async function createAt(name, startsAt) {
  // Through h.req, so it carries a token: creating an event is a write and
  // writes require an account.
  const res = await h.req('POST', '/api/catalog/events', {
    name,
    venue: 'Listing Arena',
    startsAt,
  });
  assert.equal(res.status, 201, `create failed: ${res.text}`);
  return res.body;
}

test('truncation is visible instead of silent', { timeout: TIMEOUT }, async () => {
  const page = await list();
  assert.equal(page.status, 200);
  assert.ok(page.body.length <= DEFAULT_LIMIT, 'default page should be bounded');
  assert.ok(Number.isFinite(page.total), 'X-Total-Count must be present');
  assert.ok(
    page.total >= page.body.length,
    'the total must account for rows the page did not return'
  );
});

test('past events do not crowd out upcoming ones', { timeout: TIMEOUT }, async () => {
  // Enough past events to fill the old 50-row cap on their own.
  const past = new Date(Date.now() - 30 * 86400000).toISOString();
  for (let i = 0; i < 25; i++) await createAt(`Past show ${i} ${Date.now()}`, past);

  // One hour out, not one day: fixtures and the load-test prep both create
  // day-out events, and enough of those would push a same-dated marker off the
  // first page - which is correct paging, but not what this test is about.
  const marker = `upcoming${Date.now()}`;
  const upcoming = await createAt(marker, new Date(Date.now() + 3600000).toISOString());

  const page = await list();
  assert.ok(
    page.body.some((e) => e._id === upcoming._id),
    'an event tomorrow must appear even with plenty of past events in the collection'
  );
  assert.ok(
    page.body.every((e) => new Date(e.startsAt) >= new Date(Date.now() - 60000) || !e.startsAt),
    'the default listing should not contain past events'
  );
});

test('past events are still reachable on request', { timeout: TIMEOUT }, async () => {
  const withPast = await list('?includePast=true');
  const withoutPast = await list();
  assert.ok(
    withPast.total > withoutPast.total,
    'includePast should widen the result set, not change the page size'
  );
  assert.equal(withPast.cache, 'BYPASS', 'non-default views are not cached');
});

test('undated events sort last, not first', { timeout: TIMEOUT }, async () => {
  const undated = await createAt(`No date yet ${Date.now()}`, undefined);

  const page = await list(`?limit=100`);
  const index = page.body.findIndex((e) => e._id === undated._id);
  if (index === -1) return; // pushed off the page by dated events, which is the point

  const dated = page.body.filter((e) => e.startsAt);
  const lastDatedIndex = page.body.findIndex((e) => e._id === dated[dated.length - 1]._id);
  assert.ok(
    index > lastDatedIndex,
    'an event with no start time should come after every dated one, not before'
  );
});

test('paging does not repeat or skip rows', { timeout: TIMEOUT }, async () => {
  // Seed enough upcoming events that two full pages are guaranteed, rather than
  // depending on whatever other tests happen to have left lying around.
  const stamp = Date.now();
  for (let i = 0; i < 12; i++) {
    await createAt(`Paged ${i} ${stamp}`, new Date(stamp + (i + 1) * 86400000).toISOString());
  }

  const first = await list('?limit=5&skip=0');
  const second = await list('?limit=5&skip=5');
  assert.equal(first.body.length, 5);

  const overlap = first.body.filter((a) => second.body.some((b) => b._id === a._id));
  assert.equal(overlap.length, 0, 'consecutive pages must not share rows');
  assert.equal(first.total, second.total, 'the total should be stable across pages');
});

test('limit is clamped, not trusted', { timeout: TIMEOUT }, async () => {
  const huge = await list('?limit=100000');
  assert.ok(huge.body.length <= 100, 'limit must be capped server-side');

  const nonsense = await list('?limit=abc&skip=-5');
  assert.equal(nonsense.status, 200, 'junk parameters should fall back to defaults, not 500');
  assert.ok(nonsense.body.length <= DEFAULT_LIMIT);
});
