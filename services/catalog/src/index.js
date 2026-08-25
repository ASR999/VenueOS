const express = require('express');
const mongoose = require('mongoose');
const { createClient } = require('redis');
const createMetrics = require('./metrics');
const { requireAuth } = require('./auth');

const PORT = process.env.PORT || 4001;
// Must stay under Docker's stop timeout (10s by default) or the container is
// SIGKILLed mid-drain and the whole exercise is pointless.
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '8000', 10);
const CACHE_TTL_SECONDS = parseInt(process.env.CACHE_TTL_SECONDS || '30', 10);
const DEFAULT_LIMIT = parseInt(process.env.DEFAULT_LIMIT || '20', 10);
const MAX_LIMIT = parseInt(process.env.MAX_LIMIT || '100', 10);
// Undated events sort after every dated one instead of before them. Mongo puts
// null first on an ascending sort, which parked "date TBA" events at the top of
// the listing - the opposite of useful.
const NO_DATE_SORTS_LAST = new Date(8640000000000000);

let server = null;
let shuttingDown = false;

// Catalog is read-heavy and its content changes rarely, so reads go through a
// cache-aside layer. This is Redis DB 1, NOT booking's DB 0: same container,
// separate logical database - the same arrangement as the shared Postgres
// container with a database per service. Catalog never sees a seat hold and
// booking never sees a cached event.
// disableOfflineQueue: without it, node-redis holds commands until Redis comes
// back, so a cache read HANGS instead of missing. A cache that can hang is a
// liability, not an optimisation - fail fast here, then fail open in cached().
const cache = createClient({ url: process.env.CACHE_REDIS_URL, disableOfflineQueue: true });
cache.on('error', (err) => console.error('catalog: cache error:', err.message));

const metrics = createMetrics('catalog');
const cacheTotal = new metrics.client.Counter({
  name: 'venueos_cache_total',
  help: 'Catalog cache lookups by result',
  labelNames: ['result'], // hit | miss | bypass
  registers: [metrics.register],
});

const app = express();
app.use(metrics.middleware);
app.get('/metrics', metrics.handler);
app.use(express.json());

const eventSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    venue: String,
    startsAt: Date,
    description: String,
  },
  { timestamps: true }
);

// A Mongo text index rather than a regex scan: regex can't use an index unless
// it is left-anchored, so it degrades into a collection scan as the catalogue
// grows. Weighted so a match on the event's name outranks one in its blurb.
eventSchema.index(
  { name: 'text', venue: 'text', description: 'text' },
  { weights: { name: 10, venue: 4, description: 1 }, name: 'event_search' }
);

const Event = mongoose.model('Event', eventSchema);

const ah = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// The cache is reported but never makes the service degraded: unlike booking's
// Redis (which is load-bearing and fails closed), a cache miss is just slower.
app.get('/health', (req, res) => {
  const ok = mongoose.connection.readyState === 1;
  res.status(ok ? 200 : 503).json({
    service: 'catalog',
    status: ok ? 'ok' : 'degraded',
    mongo: ok ? 'ok' : 'down',
    cache: cache.isReady ? 'ok' : 'down',
  });
});

// Cache-aside, failing OPEN: any cache error degrades to a Mongo read rather
// than an error. A cache that can take the service down is worse than no cache.
async function cached(key, res, load) {
  try {
    const hit = await cache.get(key);
    if (hit !== null) {
      res.set('X-Cache', 'HIT');
    cacheTotal.inc({ result: 'hit' });
      return res.type('json').send(hit);
    }
  } catch (err) {
    console.error('catalog: cache read failed, serving from mongo:', err.message);
    res.set('X-Cache', 'BYPASS');
    cacheTotal.inc({ result: 'bypass' });
    return res.json(await load());
  }

  const value = await load();
  res.set('X-Cache', 'MISS');
    cacheTotal.inc({ result: 'miss' });
  // Serialised once, stored exactly as it goes over the wire, so a HIT and a
  // MISS are byte-identical.
  const body = JSON.stringify(value);
  try {
    await cache.set(key, body, { EX: CACHE_TTL_SECONDS });
  } catch (err) {
    console.error('catalog: cache write failed:', err.message);
  }
  return res.type('json').send(body);
}

// Like cached(), but the total is cached WITH the body. Setting X-Total-Count
// only on the load path would make the header appear on a MISS and vanish on a
// HIT - a response that changes shape depending on cache state is worse than no
// header at all. The stored envelope keeps the wire format an array.
async function cachedListing(key, res, load) {
  try {
    const hit = await cache.get(key);
    if (hit !== null) {
      const { total, events } = JSON.parse(hit);
      res.set('X-Cache', 'HIT');
    cacheTotal.inc({ result: 'hit' });
      res.set('X-Total-Count', String(total));
      return res.json(events);
    }
  } catch (err) {
    console.error('catalog: cache read failed, serving from mongo:', err.message);
    const [events, total] = await load();
    res.set('X-Cache', 'BYPASS');
    cacheTotal.inc({ result: 'bypass' });
    res.set('X-Total-Count', String(total));
    return res.json(events);
  }

  const [events, total] = await load();
  res.set('X-Cache', 'MISS');
    cacheTotal.inc({ result: 'miss' });
  res.set('X-Total-Count', String(total));
  try {
    await cache.set(key, JSON.stringify({ total, events }), { EX: CACHE_TTL_SECONDS });
  } catch (err) {
    console.error('catalog: cache write failed:', err.message);
  }
  return res.json(events);
}

async function invalidate(...keys) {
  try {
    await cache.del(keys);
  } catch (err) {
    // Worst case the stale entry lives out its TTL - seconds, not forever.
    console.error('catalog: cache invalidation failed:', err.message);
  }
}

// The listing was `.sort({ startsAt: 1 }).limit(50)` with no date filter, which
// fails three ways as the catalogue grows: past events crowd out upcoming ones,
// undated events sort to the very top, and anything past the 50th is dropped
// with a 200 and no indication that it happened.
function listEvents({ limit, skip, includePast }) {
  const match = includePast ? {} : { $or: [{ startsAt: { $gte: new Date() } }, { startsAt: null }] };
  return Promise.all([
    Event.aggregate([
      { $match: match },
      { $addFields: { sortAt: { $ifNull: ['$startsAt', NO_DATE_SORTS_LAST] } } },
      { $sort: { sortAt: 1, _id: 1 } }, // _id breaks ties, so paging can't repeat or skip a row
      { $skip: skip },
      { $limit: limit },
      { $unset: 'sortAt' },
    ]),
    Event.countDocuments(match),
  ]);
}

app.get(
  '/events',
  ah(async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);
    const includePast = req.query.includePast === 'true';

    if (!q) {
      // Only the default view is cached. Caching per-parameter would let anyone
      // fill Redis with keys just by varying skip - the same reasoning that
      // keeps search results uncached.
      const isDefaultView = limit === DEFAULT_LIMIT && skip === 0 && !includePast;
      if (!isDefaultView) {
        const [events, total] = await listEvents({ limit, skip, includePast });
        res.set('X-Cache', 'BYPASS');
    cacheTotal.inc({ result: 'bypass' });
        res.set('X-Total-Count', String(total));
        return res.json(events);
      }
      return cachedListing('events:list', res, () => listEvents({ limit, skip, includePast }));
    }
    // Search results are deliberately NOT cached. The cache key would include
    // the query string, so anyone could fill Redis with junk keys just by
    // searching for gibberish. The index is what makes this fast; the cache is
    // for the one URL everybody hits.
    res.set('X-Cache', 'BYPASS');
    cacheTotal.inc({ result: 'bypass' });
    const results = await Event.find(
      { $text: { $search: q } },
      { score: { $meta: 'textScore' } }
    )
      .sort({ score: { $meta: 'textScore' } })
      .limit(limit);
    // Search deliberately ignores the upcoming filter: if you searched for it by
    // name, you want it found whether or not it has already happened.
    res.json(results);
  })
);

app.get(
  '/events/:id',
  ah(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'invalid event id' });
    }
    // Checked before caching, so a 404 is never cached as a body.
    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ error: 'event not found' });
    return cached(`event:${req.params.id}`, res, async () => event);
  })
);

app.post(
  '/events',
  requireAuth,
  ah(async (req, res) => {
    const { name, venue, startsAt, description } = req.body || {};
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    const event = await Event.create({ name: name.trim(), venue, startsAt, description });
    await invalidate('events:list');
    res.status(201).json(event);
  })
);

app.use((err, req, res, next) => {
  console.error('catalog: unhandled error:', err.message);
  res.status(500).json({ error: 'internal error' });
});

async function start() {
  await mongoose.connect(process.env.MONGO_URL);
  // Awaited: serving searches before the text index exists would silently error
  // on every query.
  await Event.init();
  // Not awaited: the cache is optional, so a slow or missing Redis must not
  // stop catalog from serving.
  cache.connect().catch((err) => console.error('catalog: cache unavailable:', err.message));
  server = app.listen(PORT, () => console.log(`catalog service listening on :${PORT}`));
}

// Stop accepting requests, let in-flight ones finish, then release resources.
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`catalog: ${signal} received — draining`);

  // Backstop, so a wedged connection can't hold the container past Docker's
  // SIGKILL deadline. unref'd: it must not itself keep the process alive.
  setTimeout(() => {
    console.error('catalog: drain timed out — exiting anyway');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  if (server) {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeIdleConnections(); // keep-alive sockets would otherwise stall close()
    await closed;
  }
  await Promise.allSettled([mongoose.disconnect(), cache.isOpen && cache.quit()]);
  console.log('catalog: drained');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch((err) => {
  console.error('catalog failed to start:', err);
  process.exit(1);
});
