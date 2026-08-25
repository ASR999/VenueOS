-- Transactional outbox. The booking state change and the intent to publish
-- commit together, so a crash between "payment succeeded" and "event published"
-- can no longer lose the event (DESIGN.md, Phase 1 known gap).
CREATE TABLE outbox (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_id TEXT NOT NULL,            -- the bookingId this event is about
  type         TEXT NOT NULL,            -- e.g. 'booking.confirmed'
  payload      JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ               -- NULL = still owed to the broker
);

-- The relay's only query. Partial, so the index holds just the backlog rather
-- than every event ever published.
CREATE INDEX outbox_unpublished_idx ON outbox (created_at) WHERE published_at IS NULL;
