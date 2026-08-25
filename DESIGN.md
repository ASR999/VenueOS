# DESIGN.md — Phase 1: Booking domain

Decisions for the booking core. Written before implementation, updated when
reality disagrees. The load tests in Phase 2 will judge this design.

**Verdict (2026-08-25).** They have. `loadtest/flash-sale.js` ramped 50 virtual
users onto 20 seats: 2,155 checkout attempts, 20 confirmed, **0 oversold**, p95
request latency 6.6ms. The Redis holds absorbed the contention as intended -
2,135 attempts were turned away at the hold, never reaching Postgres - and the
partial unique index admitted exactly one booking per seat. The design stands.

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
   - failed/rejected → `UPDATE status='cancelled'`, `DEL` hold → `402`/`502`.
     This is *only* a `2xx` carrying `status: "failed"` or a `4xx` — cases where
     the payment service understood the request and refused it. Nothing else.
   - unknown → booking **stays pending**, `502` to the caller; the reconciling
     sweep (below) resolves it. Never assume a timeout means "not charged."
     **A `5xx` is unknown, not a rejection** (corrected 2026-08-25): payment can
     crash after its INSERT commits, and the gateway returns its own `502`/`504`
     when payment is slow or restarting. Both look identical to a clean refusal
     at the HTTP layer, and both may have taken money.

All pending→terminal transitions are guarded with `AND status='pending'`, so
a booking the sweep already resolved can never be overridden or resurrected.

### The outbox

`booking.confirmed` is never published from a request handler. `settleBooking`
writes the status change and an `outbox` row in one transaction, so the booking
being confirmed and the event being owed are the same fact - there is no window
where one is true and the other isn't.

A relay drains the table: `SELECT ... FOR UPDATE SKIP LOCKED` (several booking
instances can relay at once without double-publishing or blocking each other),
publish with a **confirm channel**, then mark `published_at`. Publishing before
marking is deliberate - the reverse would lose events - and it makes delivery
at-least-once, which is why the consumer dedupes.

This does hold row locks across a network call, which the booking path
deliberately never does. The difference: these locks are on outbox rows nobody
contends for, and `SKIP LOCKED` turns contention into a no-op rather than a queue.

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

## What the metrics actually showed (2026-08-25)

Instrumenting the hold path contradicted the story above, and the numbers are
worth keeping. Over a flash-sale run - 50 VUs, 20 seats, 2,149 attempts:

```
tickethub_holds_total{outcome="won"}     22
tickethub_holds_total{outcome="lost"}     1     <- genuine Redis NX races
tickethub_holds_total{outcome="booked"} 2129    <- rejected by the Postgres pre-check
```

k6 counted 2,129 "holds lost", which reads like the Redis layer absorbing a
flash sale. It wasn't. `POST /holds` runs `SELECT 1 FROM bookings WHERE seat_id
= $1 AND status <> 'cancelled'` *before* it touches Redis, so once a seat is
sold every further attempt is turned away by Postgres - the exact database load
the hold layer was chosen to absorb. Only **one** request in the whole run lost
a real `SET NX` race.

That pre-check is not wrong: it gives a fast, honest 409 and stops users holding
seats they can never book. But "contention is absorbed before Postgres" is only
true while a seat is *unsold*. In the sellout phase - the phase a flash sale
mostly consists of - every attempt costs a Postgres round trip.

Worth deciding, not yet decided: the sold-out set is small, bounded, and changes
only on booking, so it could live in Redis as a negative cache and let the hold
layer answer these itself. Recorded here rather than acted on, because the
locking strategy is a decision this file owns.

## Failure edges (design-for, not hope-against)

| Edge | Outcome |
| --- | --- |
| Two users hold same seat same ms | Redis `NX` is atomic — exactly one wins. |
| Hold expires during payment | Pending row already exists; constraint blocks rivals. |
| Payment succeeds, confirm-update crashes | Booking stays `pending`; the reconciling sweep queries payment by idempotency key (= bookingId), finds `succeeded`, and **confirms** it — the user keeps the seat they paid for. |
| Payment call times out (outcome unknown) | Booking stays `pending`, caller gets `502`; sweep reconciles: confirm if charged, cancel if not. No cancel-on-timeout, so no double charge on retry. |
| Payment returns `5xx`, or the gateway returns a proxy error | Same as a timeout — treated as unknown. Booking stays `pending`, sweep decides from the payment record. Cancelling here would strand a real charge (next row). |
| Booking is `cancelled` but a charge exists for its key | **Unreconciled — known gap.** The sweep only revisits `pending` rows, so nothing ever notices. Closing this needs a refund/void endpoint on payment plus a sweep over recently-cancelled bookings. Deferred; the `5xx`-is-unknown rule above removes the only path that reached it in practice. |
| User abandons payment | Pending booking passes `expires_at`; sweep finds no payment for the key and cancels, freeing the seat. |
| RabbitMQ down at publish | **Closed 2026-08-25.** The event is written to the `outbox` table in the same transaction as the confirmation, so it cannot be lost by a broker outage or a crash. A relay drains it on a timer, nudged after each confirmation, and publishes with publisher confirms - a row is marked published only once the broker has acknowledged it. Covered by `tests/outbox.test.js`, which books a seat with RabbitMQ stopped and watches the event go out on reconnect. |
| Redis restarts (holds lost) | Multiple users may *believe* they hold; constraint picks one winner at insert. Overselling of holds possible, of bookings impossible. |
| Redis down | Every hold/seat-map/booking request returns 503 (fail closed) and returns it *fast*. Existing pending bookings unaffected. Corrected 2026-08-25: this table said 503 but the request actually hung forever, because node-redis queues commands while disconnected - the client now sets `disableOfflineQueue`. An unreachable Redis must never read as "no hold exists". |
| Booking restarted mid-request | SIGTERM drains: the sweep stops scheduling, the server stops accepting, in-flight bookings finish, then pg/Redis/AMQP close (added 2026-08-25 - previously every service was SIGKILLed, exit 137). A booking still cut off mid-payment stays `pending` and the sweep reconciles it on the next boot. |
| Double-publish / consumer replay | **Closed 2026-08-25.** The relay publishes then marks the row; a failure between the two re-sends, so delivery is deliberately at-least-once. Notifications claims `sent:{bookingId}` in Redis with `SET NX` before sending - the same atomic primitive as a seat hold, for the same reason. The dedupe store fails OPEN: a duplicate email is a nuisance, a missing one is a customer who thinks they have no ticket. |
| RabbitMQ restarts under a live consumer | Notifications reports `degraded` for the duration and reconnects in-process (fixed 2026-08-25; it previously exited after 10 attempts and, worse, kept reporting `ok` while holding a dead connection). Covered by `tests/resilience.test.js`. Note the restart policy does not help here - the process never exited, it just stopped consuming. |

## Explicitly deferred

- ~~**Outbox pattern** for atomically-published events~~ — done 2026-08-25; see the failure-edge table and `migrations/003_outbox.sql`.
- **Auth**: `userId` is a client-supplied header. Fake, fine for now.
- **Seat seeding**: script/admin endpoint, not a product feature.
- **Multi-seat bookings** (lock-ordering lessons) → after single-seat works.
- **Refunds / voids** on the payment service, and the cancelled-but-charged
  reconciliation that depends on them (see the failure-edge table).

## Definition of done for Phase 1

The concurrency test: N parallel booking attempts for one seat → exactly one
`201`, N−1 clean rejections, one row in `bookings`, one `booking.confirmed`
event consumed. If that test flakes even once, the design is wrong.

**Met 2026-08-25.** `tests/concurrency.test.js`, run against the real stack
through the gateway. Both races are covered: N holds on one seat (Redis `NX`
arbitrates) and N bookings from a caller who legitimately holds it (the partial
unique index arbitrates, with Redis waving everyone through — the retry-storm
and lost-hold shape). Clean at N=20 and N=75, repeated runs, no flakes.

The failure edges are covered too, in `tests/recovery.test.js`: the payment
container is stopped mid-flow so the gateway answers with a 5xx, and the sweep
is then observed cancelling the booking when no charge exists and *confirming*
it when one does. That second test is the one that matters — it is the
"payment succeeds, confirm-update crashes" row of the table above, and it is
what a cancel-on-ambiguity bug looks like from the outside.
