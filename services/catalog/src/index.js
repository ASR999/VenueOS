const express = require('express');
const mongoose = require('mongoose');

const PORT = process.env.PORT || 4001;
// Must stay under Docker's stop timeout (10s by default) or the container is
// SIGKILLed mid-drain and the whole exercise is pointless.
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '8000', 10);

let server = null;
let shuttingDown = false;

const app = express();
app.use(express.json());

const Event = mongoose.model(
  'Event',
  new mongoose.Schema(
    {
      name: { type: String, required: true },
      venue: String,
      startsAt: Date,
      description: String,
    },
    { timestamps: true }
  )
);

const ah = (fn) => (req, res, next) => fn(req, res, next).catch(next);

app.get('/health', (req, res) => {
  const ok = mongoose.connection.readyState === 1;
  res
    .status(ok ? 200 : 503)
    .json({ service: 'catalog', status: ok ? 'ok' : 'degraded', mongo: ok ? 'ok' : 'down' });
});

app.get(
  '/events',
  ah(async (req, res) => {
    const events = await Event.find().sort({ startsAt: 1 }).limit(50);
    res.json(events);
  })
);

app.get(
  '/events/:id',
  ah(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'invalid event id' });
    }
    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ error: 'event not found' });
    res.json(event);
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
    res.status(201).json(event);
  })
);

app.use((err, req, res, next) => {
  console.error('catalog: unhandled error:', err.message);
  res.status(500).json({ error: 'internal error' });
});

async function start() {
  await mongoose.connect(process.env.MONGO_URL);
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
  await Promise.allSettled([mongoose.disconnect()]);
  console.log('catalog: drained');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch((err) => {
  console.error('catalog failed to start:', err);
  process.exit(1);
});
