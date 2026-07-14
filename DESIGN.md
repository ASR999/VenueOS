# DESIGN.md — Phase 1: Booking domain

Decisions for the booking core. Written before implementation, updated when
reality disagrees. The load tests in Phase 2 will judge this design.

## Decision: locking strategy (2026-07-14)

**Chosen: Redis holds + Postgres unique constraint backstop** (over pessimistic
`SELECT FOR UPDATE` and pure optimistic conditional writes).

- Seat holds live in Redis: `SET hold:{eventId}:{seatId} {userId} NX EX 300`.
  Atomic first-come-first-served claim, auto-expires in 5 minutes. This is the
  *speed layer* — it absorbs flash-sale contention and gives the "seat reserved
  while you pay" UX.
- The *law* is in Postgres: a partial unique index allows at most one active
  booking per seat. Redis can lie, restart, or race — the constraint cannot.
- Rationale: the hold mechanism is required for the UX anyway; contention is
  absorbed before Postgres; closest to how real ticketing systems work.
  Trade-off accepted: two systems with consistency edges (enumerated below).

## Data model

Catalog (Mongo) owns event *content*; booking (Postgres) owns seat *inventory*.
They share only `eventId` (the catalog Mongo `_id` as a string). No joins, no
shared database — consistent with the hard rules.

### catalog — Mongo `events` collection

```js
{ _id, name, venue, startsAt, description }
```

### booking — Postgres

```sql
CREATE TABLE seats (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    TEXT NOT NULL,            -- catalog's eventId
  label       TEXT NOT NULL,            -- e.g. "A-12"
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
  expires_at  TIMESTAMPTZ,              -- for pending bookings only
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- THE LAW: at most one active booking per seat. Partial so a cancelled
-- booking frees the seat for rebooking.
CREATE UNIQUE INDEX one_active_booking_per_seat
  ON bookings (seat_id) WHERE status <> 'cancelled';
```

No `status` column on seats — a seat's availability is *derived* (no active
booking + no Redis hold), never stored twice. One source of truth per fact.

### payment — Postgres

```sql
CREATE TABLE payments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key TEXT NOT NULL UNIQUE, -- callers use bookingId
  booking_id      TEXT NOT NULL,
  amount_cents    INTEGER NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Replaying a request with a known `idempotency_key` returns the stored result —
no double charge, ever. Reusing a key with a *different* `booking_id` or
`amount_cents` is rejected with `409` (Stripe-style). Payments are queryable
by key (`GET /payments/key/:idempotencyKey`) so the booking sweep can
reconcile unknown outcomes. (Mock: request may pass `simulate: "fail"`.)

## Flows

### Hold a seat — `POST /holds`

1. `SET hold:{eventId}:{seatId} {userId} NX EX 300` in Redis.
2. Success → `201 { expiresAt }`. Key already exists → `409 seat held`.

### Book — `POST /bookings` (called while holding)

1. Verify the caller owns the hold (`GET hold:…` === userId). No → `409`.
2. INSERT booking `status='pending'`, `expires_at = now() + 5 min`.
   Unique-index violation → seat already actively booked → `409`.
   **The pending row is inserted *before* payment** — from this moment the
   constraint protects the seat even if the Redis hold expires mid-payment.
3. Call payment service (HTTP via gateway) with `idempotencyKey = bookingId`.
4. Settle. Payment outcomes are **three-valued** — succeeded, rejected, or
   *unknown* (timeout/network error, where the charge may exist server-side):
   - succeeded → `UPDATE status='confirmed'` (guarded `AND status='pending'`),
     publish `booking.confirmed`, `DEL` hold → `201`.
   - failed/rejected (payment service answered — definitely no charge) →
     `UPDATE status='cancelled'`, `DEL` hold → `402`/`502`.
   - unknown → booking **stays pending**, `502` to the caller; the reconciling
     sweep (below) resolves it. Never assume a timeout means "not charged."

All pending→terminal transitions are guarded with `AND status='pending'`, so
a booking the sweep already resolved can never be overridden or resurrected.

### The reconciling sweep

Every `SWEEP_INTERVAL_MS`, expired pending bookings are resolved against the
payment service (lookup by `idempotencyKey = bookingId`):

- payment `succeeded` → booking **confirmed** (recovered), event published.
- payment `failed` or not found → booking cancelled, seat freed.
- payment service unreachable → left pending; retried next cycle.

The payment outcome — not the timer — decides. A paid booking is never
cancelled by the sweep.

### Availability — `GET /events/:eventId/seats`

Seats LEFT JOIN active bookings, then overlay Redis holds (`MGET`). Returns
`available | held | booked` per seat.

## Failure edges (design-for, not hope-against)

| Edge | Outcome |
| --- | --- |
| Two users hold same seat same ms | Redis `NX` is atomic — exactly one wins. |
| Hold expires during payment | Pending row already exists; constraint blocks rivals. |
| Payment succeeds, confirm-update crashes | Booking stays `pending`; the reconciling sweep queries payment by idempotency key (= bookingId), finds `succeeded`, and **confirms** it — the user keeps the seat they paid for. |
| Payment call times out (outcome unknown) | Booking stays `pending`, caller gets `502`; sweep reconciles: confirm if charged, cancel if not. No cancel-on-timeout, so no double charge on retry. |
| User abandons payment | Pending booking passes `expires_at`; sweep finds no payment for the key and cancels, freeing the seat. |
| RabbitMQ down at publish | Event is lost (logged loudly); the connection retries forever so the window is brief. Accepted Phase 1 gap — the outbox pattern (Phase 3) makes publishes atomic with the booking write. |
| Redis restarts (holds lost) | Multiple users may *believe* they hold; constraint picks one winner at insert. Overselling of holds possible, of bookings impossible. |
| Redis down | Hold creation returns 503 (fail closed). Existing pending bookings unaffected. |
| Double-publish / consumer replay | Notifications consumer must be idempotent (dedupe on bookingId). Formalized in Phase 3. |

## Explicitly deferred

- **Outbox pattern** for atomically-published events → Phase 3.
- **Auth**: `userId` is a client-supplied header. Fake, fine for now.
- **Seat seeding**: script/admin endpoint, not a product feature.
- **Multi-seat bookings** (lock-ordering lessons) → after single-seat works.

## Definition of done for Phase 1

The concurrency test: N parallel booking attempts for one seat → exactly one
`201`, N−1 clean rejections, one row in `bookings`, one `booking.confirmed`
event consumed. If that test flakes even once, the design is wrong.
