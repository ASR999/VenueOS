// The only assertion that actually matters after a load test: did the locking
// design hold? Reads the source of truth directly - if two active bookings ever
// share a seat, the partial unique index failed and the design is wrong.
//   node loadtest/verify.js <eventId>
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const COMPOSE = ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.test.yml'];
const eventId = process.argv[2];

if (!eventId) {
  console.error('usage: node loadtest/verify.js <eventId>');
  process.exit(1);
}

function psql(sql) {
  return execFileSync(
    'docker',
    [...COMPOSE, 'exec', '-T', 'postgres', 'psql', '-U', 'dev', '-d', 'booking', '-tAc', sql],
    { cwd: ROOT, encoding: 'utf8' }
  ).trim();
}

const doubleBooked = psql(
  `SELECT count(*) FROM (
     SELECT seat_id FROM bookings
     WHERE event_id = '${eventId}' AND status <> 'cancelled'
     GROUP BY seat_id HAVING count(*) > 1
   ) t`
);

const seats = psql(`SELECT count(*) FROM seats WHERE event_id = '${eventId}'`);
const confirmed = psql(
  `SELECT count(*) FROM bookings WHERE event_id = '${eventId}' AND status = 'confirmed'`
);
const cancelled = psql(
  `SELECT count(*) FROM bookings WHERE event_id = '${eventId}' AND status = 'cancelled'`
);
const pending = psql(
  `SELECT count(*) FROM bookings WHERE event_id = '${eventId}' AND status = 'pending'`
);

console.log(`seats:      ${seats}`);
console.log(`confirmed:  ${confirmed}`);
console.log(`pending:    ${pending}`);
console.log(`cancelled:  ${cancelled}`);
console.log(`oversold:   ${doubleBooked}`);

if (Number(doubleBooked) !== 0) {
  console.error(`\nFAIL: ${doubleBooked} seat(s) have more than one active booking. Seats were oversold.`);
  process.exit(1);
}
if (Number(confirmed) > Number(seats)) {
  console.error(`\nFAIL: ${confirmed} confirmed bookings for only ${seats} seats.`);
  process.exit(1);
}
console.log('\nPASS: every seat has at most one active booking.');
