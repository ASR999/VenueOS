const express = require('express');
const { Pool } = require('pg');

const PORT = process.env.PORT || 4003;

const app = express();
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ service: 'payment', status: 'ok', postgres: 'ok' });
  } catch {
    res.status(503).json({ service: 'payment', status: 'degraded', postgres: 'down' });
  }
});

app.listen(PORT, () => console.log(`payment service listening on :${PORT}`));
