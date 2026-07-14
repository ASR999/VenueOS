// Seed seats for an event: node scripts/seed.js <eventId> [rows] [seatsPerRow]
// Idempotent — re-running skips existing seats via ON CONFLICT.
const { Pool } = require('pg');

const eventId = process.argv[2];
const rowCount = parseInt(process.argv[3] || '5', 10);
const perRow = parseInt(process.argv[4] || '10', 10);

if (!eventId) {
  console.error('usage: node scripts/seed.js <eventId> [rows] [seatsPerRow]');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  let inserted = 0;
  for (let r = 0; r < rowCount; r++) {
    const rowLabel = String.fromCharCode(65 + r); // A, B, C…
    for (let n = 1; n <= perRow; n++) {
      const priceCents = 5000 - r * 500; // front rows cost more
      const result = await pool.query(
        `INSERT INTO seats (event_id, label, price_cents)
         VALUES ($1, $2, $3)
         ON CONFLICT (event_id, label) DO NOTHING`,
        [eventId, `${rowLabel}-${n}`, priceCents]
      );
      inserted += result.rowCount;
    }
  }
  console.log(`seeded ${inserted} seats for event ${eventId} (${rowCount} rows × ${perRow})`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
