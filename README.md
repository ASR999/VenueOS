# TicketHub

Event ticket booking platform built as a microservices learning project
(system design + DevOps, entirely free to run).

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
| `tests/outbox.test.js` | The transactional outbox: events survive a broker outage and are relayed on reconnect; cancelled bookings emit nothing. Stops RabbitMQ. |
| `tests/idempotency.test.js` | A redelivered `booking.confirmed` does not send a second email. |
| `tests/caching.test.js` | Catalog's cache-aside layer: hits, invalidation on write, TTL expiry, and that a dead cache degrades to Mongo instead of failing. |
| `tests/throttling.test.js` | The gateway rate limiter trips, its window rolls over, and `/health` is never throttled. |
| `tests/shutdown.test.js` | Every service drains on SIGTERM (exit 0, not 137), the aggregate health endpoint returns 503 when a dependency is down, and a Redis outage fails holds fast and closed. Stops the whole app tier. |

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

Last run: 2,155 checkout attempts, 20 seats, **20 confirmed, 0 oversold**,
p95 request latency 6.6ms.

> On Windows, run the `docker compose ... run` line from PowerShell, or prefix it
> with `MSYS_NO_PATHCONV=1` in Git Bash - otherwise `/scripts/flash-sale.js` is
> rewritten to a Windows path before Docker sees it.

See [CLAUDE.md](./CLAUDE.md) for architecture, conventions, and the roadmap.
