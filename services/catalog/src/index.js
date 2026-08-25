const express = require('express');
const mongoose = require('mongoose');
const { createClient } = require('redis');

const PORT = process.env.PORT || 4001;
// Must stay under Docker's stop timeout (10s by default) or the container is
// SIGKILLed mid-drain and the whole exercise is pointless.
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '8000', 10);
const CACHE_TTL_SECONDS = parseInt(process.env.CACHE_TTL_SECONDS || '30', 10);

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

const app = express();
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
      return res.type('json').send(hit);
    }
  } catch (err) {
    console.error('catalog: cache read failed, serving from mongo:', err.message);
    res.set('X-Cache', 'BYPASS');
    return res.json(await load());
  }

  const value = await load();
  res.set('X-Cache', 'MISS');
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

async function invalidate(...keys) {
  try {
    await cache.del(keys);
  } catch (err) {
    // Worst case the stale entry lives out its TTL - seconds, not forever.
    console.error('catalog: cache invalidation failed:', err.message);
  }
}

app.get(
  '/events',
  ah(async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q) {
      return cached('events:list', res, () => Event.find().sort({ startsAt: 1 }).limit(50));
    }
    // Search results are deliberately NOT cached. The cache key would include
    // the query string, so anyone could fill Redis with junk keys just by
    // searching for gibberish. The index is what makes this fast; the cache is
    // for the one URL everybody hits.
    res.set('X-Cache', 'BYPASS');
    const results = await Event.find(
      { $text: { $search: q } },
      { score: { $meta: 'textScore' } }
    )
      .sort({ score: { $meta: 'textScore' } })
      .limit(50);
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
