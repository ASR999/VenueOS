const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const PORT = process.env.PORT || 8080;
// Must stay under Docker's stop timeout (10s by default) or the container is
// SIGKILLed mid-drain and the whole exercise is pointless.
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '8000', 10);

let server = null;
let shuttingDown = false;

const services = {
  catalog: process.env.CATALOG_URL || 'http://localhost:4001',
  booking: process.env.BOOKING_URL || 'http://localhost:4002',
  payment: process.env.PAYMENT_URL || 'http://localhost:4003',
  notifications: process.env.NOTIFICATIONS_URL || 'http://localhost:4004',
};

const app = express();

async function aggregateHealth(req, res) {
  const results = {};
  await Promise.all(
    Object.entries(services).map(async ([name, url]) => {
      try {
        const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
        results[name] = await r.json();
      } catch {
        results[name] = { service: name, status: 'unreachable' };
      }
    })
  );
  // 200 only when every dependency is ok. An aggregate that always answers 200
  // cannot be alerted on, which defeats the point of aggregating.
  const ok = Object.values(results).every((s) => s.status === 'ok');
  res.status(ok ? 200 : 503).json({
    gateway: 'ok', // the gateway itself answered
    status: ok ? 'ok' : 'degraded',
    services: results,
  });
}

app.get('/health', aggregateHealth);
app.get('/api/health', aggregateHealth);

// Public routes: /api/<service>/* -> <service>/*. Notifications is queue-driven
// and internal-only, so it gets no public route.
for (const [name, target] of Object.entries(services)) {
  if (name === 'notifications') continue;
  app.use(
    `/api/${name}`,
    createProxyMiddleware({
      target,
      changeOrigin: true,
      pathRewrite: { [`^/api/${name}`]: '' },
    })
  );
}

server = app.listen(PORT, () => console.log(`gateway listening on :${PORT}`));

// Stop accepting requests, let in-flight ones finish, then release resources.
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`gateway: ${signal} received — draining`);

  // Backstop, so a wedged connection can't hold the container past Docker's
  // SIGKILL deadline. unref'd: it must not itself keep the process alive.
  setTimeout(() => {
    console.error('gateway: drain timed out — exiting anyway');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  if (server) {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeIdleConnections(); // keep-alive sockets would otherwise stall close()
    await closed;
  }
  await Promise.allSettled([]);
  console.log('gateway: drained');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

