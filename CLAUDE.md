# TicketHub — event ticket booking platform (learning project)

A learning project for system design + DevOps, built as microservices from day
one, deliberately. Everything must stay completely free: open-source containers
locally; the future AWS phase must fit inside the Free Plan credit cap (no
managed databases — no DocumentDB, no steady-state RDS/ElastiCache, no EKS).

## Architecture

React client (Vite, :5173) → API gateway (Express proxy, :8080) → services:

| Service       | Port | Datastore        | Character                                  |
| ------------- | ---- | ---------------- | ------------------------------------------ |
| catalog       | 4001 | MongoDB          | events/venues; read-heavy, cache-friendly  |
| booking       | 4002 | Postgres + Redis | seat holds/reservations; transactional core |
| payment       | 4003 | Postgres         | mock payments; idempotency                 |
| notifications | 4004 | Redis DB 2       | consumes `booking.confirmed`; dedupes on bookingId |

Gateway routes `/api/<service>/*` → service. Notifications has no public route.

## Hard rules

- Services NEVER access another service's database. Cross-service communication
  is HTTP via the gateway or RabbitMQ events — nothing else.
- Booking correctness beats everything: no code path may allow double-booking
  a seat. Locking strategy decisions get recorded here when made.
- **Locking strategy (decided 2026-07-14):** Redis seat holds (`SET NX EX`)
  as the speed layer + a partial unique index on active bookings in Postgres
  as the source of truth. Pending bookings are inserted *before* payment so
  the constraint protects the seat even if the hold expires. Full rationale
  and failure-edge table in DESIGN.md — read it before touching booking code.
- Postgres is deliberate for booking/payment (row locking, constraints,
  transactions); MongoDB is deliberate for catalog. Don't "simplify" to one DB.

## Running

```
docker compose up --build          # all services + mongo/postgres/redis/rabbitmq
cd client && npm install && npm run dev   # React app on :5173
```

- Aggregate health: http://localhost:8080/health
- RabbitMQ management UI: http://localhost:15672 (guest/guest)
- Demo data: create an event (`POST /api/catalog/events` with `{name, venue,
  startsAt}`), then seed its seats with the returned `_id`:
  `docker compose exec booking node scripts/seed.js <eventId>`
- Demo the full flow: `POST /api/booking/holds` then `POST /api/booking/bookings`
  (body: eventId, seatId, userId), then `docker compose logs notifications`
  for the mock confirmation email. `simulatePaymentFailure: true` in the
  booking body exercises the payment-failed path.
- Tests: bring the stack up with the `docker-compose.test.yml` overlay (short
  hold/sweep timers), then `npm test` from the repo root. See README.md.

## Conventions

- Services are plain JavaScript, CommonJS, Express; entry point `src/index.js`.
  Client is ESM/React. No TypeScript for now.
- All config via environment variables (set in docker-compose.yml); no
  hardcoded hosts/ports/credentials. Booking's tunables are `HOLD_TTL_SECONDS`,
  `SWEEP_INTERVAL_MS` and `PAYMENT_TIMEOUT_MS` - all defaulted in code and
  overridden by `docker-compose.test.yml`.
- Events are published through the outbox, never directly from a request
  handler. If you find yourself calling `channel.sendToQueue` outside the relay,
  the write and the publish are no longer atomic and the pattern is defeated.
- Collection endpoints paginate and report the true total (`X-Total-Count`).
  Returning a truncated list with a 200 and no indication is how a real event
  went missing from the UI - found by clicking through it, not by a test.
- Every service exposes `GET /health` reporting its own dependencies. Health
  must be derived from live state (e.g. `channel !== null`), never a flag set
  once at startup - a health check that cannot go from ok back to degraded is
  worse than none.
- Long-lived connections (RabbitMQ) reconnect forever rather than exiting after
  N attempts: a service that gives up looks alive while silently doing nothing.
  Attach the `close`-triggered reconnect only after setup succeeds, so a failure
  mid-setup is retried by the loop and not by a second competing one.
- Images build with `npm ci` from a committed `package-lock.json`; every service
  and the gateway has one.
- Every service handles SIGTERM/SIGINT: stop accepting requests, let in-flight
  ones finish, then close pg/Redis/AMQP. This is not optional in Docker - Node
  runs as PID 1, and the kernel does not deliver SIGTERM to PID 1 unless a
  handler is registered, so a service without one is SIGKILLed (exit 137) and
  drains nothing. Keep `SHUTDOWN_TIMEOUT_MS` under Docker's stop timeout.
- `GET /health` returns 503, not 200, when the service is degraded - including
  the gateway's aggregate, which is 200 only when every dependency is ok.
- One Postgres container, but separate databases per service (`booking`,
  `payment`) — created in `infra/postgres/init.sql`. Schema/migrations live
  with the owning service (tooling comes in Phase 1).
- Same arrangement for Redis: one container, one logical DB per service.
  Booking owns DB 0 (seat holds), catalog owns DB 1 (read cache), notifications
  owns DB 2 (consumer dedupe). A service never touches another's DB index -
  that is the hard rule, not an exception.
- Redis clients set `disableOfflineQueue`. Without it node-redis holds commands
  until Redis returns, so a request hangs instead of failing - which is worse
  than either failing open or closed.
- A dependency is either load-bearing or optional, and the code has to say
  which. Booking's Redis is load-bearing: it fails CLOSED (503), because an
  unreachable Redis must never read as "no hold exists". Catalog's cache is
  optional: it fails OPEN (serves from Mongo, `X-Cache: BYPASS`) and never
  makes the service degraded.

## Roadmap

1. **Phase 1** — booking domain: events/seats schema, seat holds with Redis
   TTL, bookings with a chosen locking strategy, mock payment flow, real
   `booking.confirmed` events. Write DESIGN.md before starting.
2. **Phase 2** — caching, rate limiting, k6 load tests against the locking
   strategy. **Done 2026-08-25**: catalog cache-aside on Redis DB 1, a gateway
   rate limiter (`RATE_LIMIT_*`, in-memory so per-instance), and `loadtest/`.
   A shared limiter store for multiple gateway instances is Phase 3.
3. **Phase 3** — outbox pattern, idempotent consumers, search. **Done
   2026-08-25**: booking writes `booking.confirmed` into an `outbox` table in
   the same transaction as the status change, and a relay drains it with
   publisher confirms and `FOR UPDATE SKIP LOCKED`. That makes delivery
   at-least-once, so notifications dedupes on bookingId before sending.
   Catalog search uses a weighted Mongo text index. Still open: a shared rate
   limiter store for multiple gateway instances.
4. **Phase 4** — AWS Free Plan deploy: EC2 + (ECS or k3s), SQS, Terraform,
   Prometheus/Grafana, CI/CD deploys.
