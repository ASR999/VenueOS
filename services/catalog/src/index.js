const express = require('express');
const mongoose = require('mongoose');

const PORT = process.env.PORT || 4001;

const app = express();
app.use(express.json());

const Event = mongoose.model(
  'Event',
  new mongoose.Schema(
    {
      name: { type: String, required: true },
      venue: String,
      startsAt: Date,
    },
    { timestamps: true }
  )
);

app.get('/health', (req, res) => {
  const ok = mongoose.connection.readyState === 1;
  res
    .status(ok ? 200 : 503)
    .json({ service: 'catalog', status: ok ? 'ok' : 'degraded', mongo: ok ? 'ok' : 'down' });
});

app.get('/events', async (req, res) => {
  const events = await Event.find().limit(50);
  res.json(events);
});

async function start() {
  await mongoose.connect(process.env.MONGO_URL);
  app.listen(PORT, () => console.log(`catalog service listening on :${PORT}`));
}

start().catch((err) => {
  console.error('catalog failed to start:', err);
  process.exit(1);
});
