const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const PORT = process.env.PORT || 8080;

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
  res.json({ gateway: 'ok', services: results });
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

app.listen(PORT, () => console.log(`gateway listening on :${PORT}`));
