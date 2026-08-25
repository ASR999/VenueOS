// Creates an event and seeds it with seats, ready for a load test run.
//   node loadtest/prepare.js [seats]
// Prints the event id; pass it to k6 as -e EVENT_ID=<id>.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const GATEWAY = process.env.GATEWAY_URL || 'http://localhost:8080';
const COMPOSE = ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.test.yml'];
// Deliberately fewer seats than the load test has virtual users: the point is
// contention, not throughput.
const SEATS = parseInt(process.argv[2] || '20', 10);

async function main() {
  const res = await fetch(`${GATEWAY}/api/catalog/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `Flash sale ${new Date().toISOString()}`,
      venue: 'Load Test Arena',
      startsAt: new Date(Date.now() + 86400000).toISOString(),
    }),
  });
  if (!res.ok) throw new Error(`could not create event: ${res.status} ${await res.text()}`);
  const event = await res.json();

  execFileSync(
    'docker',
    [...COMPOSE, 'exec', '-T', 'booking', 'node', 'scripts/seed.js', event._id, '1', String(SEATS)],
    { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] }
  );

  console.log(`\nEVENT_ID=${event._id}`);
  console.log(
    `\ndocker compose --profile loadtest run --rm k6 run /scripts/flash-sale.js -e EVENT_ID=${event._id}`
  );
  console.log(`node loadtest/verify.js ${event._id}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
