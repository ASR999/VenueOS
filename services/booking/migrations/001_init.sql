CREATE TABLE seats (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    TEXT NOT NULL,
  label       TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  UNIQUE (event_id, label)
);

CREATE TABLE bookings (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seat_id     UUID NOT NULL REFERENCES seats(id),
  event_id    TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'cancelled')),
  payment_id  TEXT,
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- THE LAW: at most one active booking per seat (see DESIGN.md). Partial so a
-- cancelled booking frees the seat for rebooking.
CREATE UNIQUE INDEX one_active_booking_per_seat
  ON bookings (seat_id) WHERE status <> 'cancelled';

CREATE INDEX bookings_event_id_idx ON bookings (event_id);
CREATE INDEX seats_event_id_idx ON seats (event_id);
