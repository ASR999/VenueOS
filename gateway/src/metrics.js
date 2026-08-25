// Prometheus instrumentation. Duplicated per service rather than shared: each
// service is its own npm package with no shared code, the same arrangement as
// migrate.js. Keep the copies in step.
const client = require('prom-client');

// The route LABEL, not the URL. `/bookings/9f2a…` as a label value would mint a
// new time series per booking and take Prometheus down with it - this is the
// classic cardinality trap. req.route.path is the pattern (`/bookings/:id`),
// which is bounded by the number of routes.
const defaultRouteLabel = (req) =>
  req.route ? `${req.baseUrl || ''}${req.route.path}` : 'unmatched';

function createMetrics(serviceName, routeLabel = defaultRouteLabel) {
  const register = new client.Registry();
  register.setDefaultLabels({ service: serviceName });
  client.collectDefaultMetrics({ register });

  const httpDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency in seconds',
    labelNames: ['method', 'route', 'status'],
    // Tuned to what this system actually does: most requests land in single-digit
    // milliseconds, and the interesting tail is the payment call at ~100ms.
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [register],
  });

  function middleware(req, res, next) {
    // Scraping shouldn't show up in the service's own latency numbers.
    if (req.path === '/metrics') return next();
    const done = httpDuration.startTimer();
    res.on('finish', () => {
      done({ method: req.method, route: routeLabel(req), status: res.statusCode });
    });
    next();
  }

  async function handler(req, res) {
    try {
      res.set('Content-Type', register.contentType);
      res.end(await register.metrics());
    } catch (err) {
      // A gauge whose collect() hits a downed database must not take the whole
      // scrape with it - a monitoring endpoint that fails when things break is
      // useless precisely when it matters.
      console.error(`${serviceName}: metrics collection failed:`, err.message);
      res.status(500).end('# metrics collection failed\n');
    }
  }

  return { register, client, middleware, handler };
}

module.exports = createMetrics;
