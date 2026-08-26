# VenueOS

Event ticket booking platform 

## Quick start

```sh
docker compose up --build
```

Then in another terminal:

```sh
cd client
npm install
npm run dev
```

Open http://localhost:5173 — browse events, hold a seat, pay (mock), get a
confirmation. Aggregate service health lives at http://localhost:8080/health.

## Accounts

Browsing is open; holding or booking a seat needs an account. The app shows a
sign-in / sign-up form first.

```sh
TOKEN=$(curl -s -X POST http://localhost:8080/api/auth/signup   -H 'Content-Type: application/json'   -d '{"email":"you@example.com","password":"correct-horse-battery"}' | jq -r .token)

curl -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/booking/bookings
```

Requests never carry a `userId`: every service verifies the JWT and reads the
caller's id from it. `POST /api/catalog/events` needs a token too.

## Listing events

`GET /api/catalog/events` returns **upcoming events only**, 20 at a time, with
the full match count in the `X-Total-Count` header so truncation is never
silent.

| Parameter | Meaning |
| --- | --- |
| `?limit=` | page size, default 20, clamped to 100 |
| `?skip=` | offset; ties break on `_id`, so pages can't repeat or drop a row |
| `?includePast=true` | include events that have already started |
| `?q=` | full-text search (ignores the upcoming filter - if you searched for it, you want it found) |

Only the bare default view is cached; any parameterised request bypasses the
cache, so the key space can't be inflated by varying `skip`.

## Tests

Integration tests run against the real stack through the gateway - no mocks, no
direct database access. They need the test overlay, which collapses the hold and
sweep timers so the reconciling sweep is observable in seconds:

```sh
docker compose -f docker-compose.yml -f docker-compose.test.yml up --build -d
npm test
```

No dependencies to install - `node:test` and `fetch` are built in.

| File | Covers |
| --- | --- |
| `tests/concurrency.test.js` | The Phase 1 definition of done: N-way contention for one seat. `RACERS=75 npm test` to crank it. |
| `tests/payment.test.js` | Rejected payments free the seat; idempotency keys can't be charged twice. |
| `tests/recovery.test.js` | Ambiguous payment outcomes stay pending, and the sweep confirms or cancels them from the payment record. Stops the payment container, so tests run serially. |
| `tests/resilience.test.js` | Services survive their dependencies restarting: notifications reports degraded during a broker outage and reconnects in-process. Restarts shared containers. |
| `tests/auth.test.js` | Signup/login, account enumeration, forged tokens, one user acting on another's seat or booking, and payment refusing user tokens. |
| `tests/metrics.test.js` | Every service exposes metrics, route labels are patterns not ids, counters move, and metrics aren't publicly reachable. |
| `tests/listing.test.js` | Event listing: upcoming-only by default, visible truncation, stable paging, clamped parameters. |
| `tests/outbox.test.js` | The transactional outbox: events survive a broker outage and are relayed on reconnect; cancelled bookings emit nothing. Stops RabbitMQ. |
| `tests/idempotency.test.js` | A redelivered `booking.confirmed` does not send a second email. |
| `tests/caching.test.js` | Catalog's cache-aside layer: hits, invalidation on write, TTL expiry, and that a dead cache degrades to Mongo instead of failing. |
| `tests/throttling.test.js` | The gateway rate limiter trips, its window rolls over, and `/health` is never throttled. |
| `tests/shutdown.test.js` | Every service drains on SIGTERM (exit 0, not 137), the aggregate health endpoint returns 503 when a dependency is down, and a Redis outage fails holds fast and closed. Stops the whole app tier. |

## CI

`.github/workflows/ci.yml` runs the whole suite on every push to `main` and on
pull requests: build the stack with the test overlay, wait for aggregate health,
`npm test`, dump service logs if anything failed, tear down. It needs no secrets
and no external services. A run takes roughly 3 minutes of test time on top of
the image build.

## Monitoring

Prometheus and Grafana run behind a profile, so the default stack and CI stay
lean:

```sh
docker compose --profile monitoring up -d
```

- Grafana: http://localhost:3000 (no login - anonymous admin, local only)
- Prometheus: http://localhost:9090

The **VenueOS overview** dashboard is provisioned automatically. Run a load
test with it open and you can watch seat contention, the outbox backlog, and
p95 latency move in real time.

Prometheus scrapes each service's `/metrics` directly on the compose network.
Those endpoints are deliberately **not** reachable through the gateway -
`/api/booking/metrics` returns 404.

| Metric | What it tells you |
| --- | --- |
| `venueos_holds_total{outcome}` | won / lost / booked - where hold attempts actually die |
| `venueos_bookings_total{status}` | confirmed / cancelled / conflict / unknown |
| `venueos_outbox_backlog` | events owed to the broker; should be 0 |
| `venueos_cache_total{result}` | catalog cache hit / miss / bypass |
| `venueos_notifications_total{outcome}` | sent vs duplicates suppressed |
| `venueos_payments_total{status}` | includes `replay`, i.e. idempotency absorbing retries |
| `venueos_sweep_recoveries_total` | paid bookings the sweep rescued |

## Load tests

k6 runs from a compose profile, so there is nothing to install. Load tests need
the rate limiter lifted, or they measure the limiter instead of the booking
path:

```sh
docker compose -f docker-compose.yml -f docker-compose.test.yml                -f docker-compose.loadtest.yml up -d

node loadtest/prepare.js 20                 # creates an event with 20 seats
docker compose --profile loadtest run --rm k6 run /scripts/flash-sale.js   -e EVENT_ID=<id>
node loadtest/verify.js <id>                # asserts no seat was oversold
```

`flash-sale.js` ramps to 50 virtual users all competing for those 20 seats.
`verify.js` is the assertion that matters - it reads Postgres directly and fails
if any seat ever ended up with two active bookings.


> On Windows, run the `docker compose ... run` line from PowerShell, or prefix it
> with `MSYS_NO_PATHCONV=1` in Git Bash - otherwise `/scripts/flash-sale.js` is
> rewritten to a Windows path before Docker sees it.


