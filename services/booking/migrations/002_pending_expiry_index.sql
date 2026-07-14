-- The sweep queries WHERE status = 'pending' AND expires_at < now() every
-- cycle; without this it seq-scans a table where settled rows accumulate
-- forever. Partial, so the index only ever contains in-flight bookings.
CREATE INDEX bookings_pending_expiry_idx
  ON bookings (expires_at) WHERE status = 'pending';
