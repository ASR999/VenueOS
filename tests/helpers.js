// Shared plumbing for the integration tests. Everything talks to the running
// stack through the gateway, exactly like a real client would — the tests know
// nothing about service internals or databases.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const GATEWAY = process.env.GATEWAY_URL || 'http://localhost:8080';
const COMPOSE_ARGS = ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.test.yml'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Never throws on a non-2xx: these tests assert on status codes, and a proxy
// error page is a legitimate response to assert about.
async function req(method, path, body) {
  const res = await fetch(`${GATEWAY}${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
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
  containerStartedAt,
  restartPolicy,
  exitCode,
  serviceHealth,
};
