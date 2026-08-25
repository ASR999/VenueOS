// Shared plumbing for the integration tests. Everything talks to the running
// stack through the gateway, exactly like a real client would — the tests know
// nothing about service internals or databases.
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const GATEWAY = process.env.GATEWAY_URL || 'http://localhost:8080';
const COMPOSE_ARGS = ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.test.yml'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Mints a service token by hand - HS256 with the shared dev secret, no library.
// That the harness can do this at all IS the documented HS256 trade-off: one
// shared key means anyone holding it can mint credentials any service trusts.
// Under RS256 only the auth service could, and this helper would be impossible.
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-not-a-real-secret';
const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

function serviceToken(name = 'test-harness') {
  const header = b64url({ alg: 'HS256', typ: 'JWT' });
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url({
    sub: `service:${name}`,
    svc: name,
    iss: 'venueos-auth',
    iat: now,
    exp: now + 300,
  });
  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

// Signs up a throwaway user and returns their bearer token. Tests that care
// about identity make their own; everything else shares one.
async function signup(label = 'tester') {
  const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const res = await fetch(`${GATEWAY}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct-horse-battery' }),
  });
  const body = await res.json();
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${JSON.stringify(body)}`);
  return { token: body.token, userId: body.user.id, email };
}

// One shared identity for the many tests that just need *a* valid caller.
let sharedUser = null;
async function defaultUser() {
  if (!sharedUser) sharedUser = await signup('shared');
  return sharedUser;
}

// Never throws on a non-2xx: these tests assert on status codes, and a proxy
// error page is a legitimate response to assert about.
//
// `token` defaults to the shared test user, so existing tests read unchanged;
// pass token: null to make a deliberately anonymous request.
async function req(method, path, body, options = {}) {
  const token =
    'token' in options ? options.token : (await defaultUser()).token;
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${GATEWAY}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* proxy errors aren't JSON; callers fall back to .text */
  }
  return { status: res.status, body: parsed, text };
}

function compose(...args) {
  return execFileSync('docker', [...COMPOSE_ARGS, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// Polls until fn() is truthy. Returns its value so callers can assert on it.
async function waitFor(fn, { timeoutMs = 30000, intervalMs = 250, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label} (last value: ${JSON.stringify(last)})`);
}

// The stack takes a while to converge on first boot (migrations, RabbitMQ).
async function waitForStack(timeoutMs = 180000) {
  let last = null;
  await waitFor(
    async () => {
      try {
        const { body } = await req('GET', '/health');
        last = body;
        return body && Object.values(body.services).every((s) => s.status === 'ok');
      } catch {
        return false; // gateway itself not listening yet
      }
    },
    { timeoutMs, intervalMs: 1000, label: 'all services healthy' }
  ).catch(() => {
    throw new Error(`stack not healthy within ${timeoutMs}ms. Last /health: ${JSON.stringify(last)}`);
  });
}

// Each test gets its own event + seats so tests never contend for the same row.
async function createEvent(name) {
  const { status, body } = await req('POST', '/api/catalog/events', {
    name: `${name} ${Date.now()}`,
    venue: 'Test Arena',
    startsAt: new Date(Date.now() + 86400000).toISOString(),
  });
  if (status !== 201) throw new Error(`could not create event: ${status} ${JSON.stringify(body)}`);
  return body;
}

function seedSeats(eventId, rows = 1, perRow = 1) {
  compose('exec', '-T', 'booking', 'node', 'scripts/seed.js', eventId, String(rows), String(perRow));
}

async function seats(eventId) {
  const { body } = await req('GET', `/api/booking/events/${eventId}/seats`);
  return body.seats;
}

// A fresh event + n seats, ready to book.
async function fixture(name, seatCount = 1) {
  const event = await createEvent(name);
  seedSeats(event._id, 1, seatCount);
  return { event, seats: await seats(event._id) };
}

// When this container's process last started. Unchanged across an outage means
// the service recovered in-process, rather than being resurrected by Docker.
function containerStartedAt(service) {
  const id = compose('ps', '-q', service).trim();
  return execFileSync('docker', ['inspect', '-f', '{{.State.StartedAt}}', id], {
    encoding: 'utf8',
  }).trim();
}

// 0 means the process drained and exited on its own. 143 is SIGTERM with no
// handler; 137 is SIGKILL after Docker's stop timeout ran out.
function exitCode(service) {
  const id = compose('ps', '-qa', service).trim();
  return parseInt(
    execFileSync('docker', ['inspect', '-f', '{{.State.ExitCode}}', id], { encoding: 'utf8' }).trim(),
    10
  );
}

function restartPolicy(service) {
  const id = compose('ps', '-qa', service).trim();
  return execFileSync('docker', ['inspect', '-f', '{{.HostConfig.RestartPolicy.Name}}', id], {
    encoding: 'utf8',
  }).trim();
}

// One service's entry in the gateway's aggregate health report.
async function serviceHealth(name) {
  const { body } = await req('GET', '/health');
  return (body && body.services && body.services[name]) || { status: 'unreachable' };
}

// waitForStack only waits for each service's `status`, and an optional
// dependency deliberately does not affect status - a dead cache must not make
// catalog unhealthy. So after Redis restarts, waitForStack returns while
// catalog's cache client is still reconnecting, and a cache assertion made in
// that window sees a correct BYPASS and fails. Tests that assert on caching
// have to wait for the real thing.
async function waitForCache(timeoutMs = 30000) {
  await waitFor(async () => (await serviceHealth('catalog')).cache === 'ok', {
    label: "catalog's cache to reconnect",
    timeoutMs,
    intervalMs: 250,
  });
}

// How many times the notifications consumer logged this bookingId. bookingIds
// are UUIDs, so a substring match over the whole log is exact.
function notificationsLogCount(needle) {
  return compose('logs', 'notifications')
    .split('\n')
    .filter((line) => line.includes(needle)).length;
}

module.exports = {
  GATEWAY,
  sleep,
  req,
  compose,
  waitFor,
  waitForStack,
  createEvent,
  seedSeats,
  seats,
  fixture,
  notificationsLogCount,
  signup,
  defaultUser,
  serviceToken,
  containerStartedAt,
  restartPolicy,
  exitCode,
  serviceHealth,
  waitForCache,
};
