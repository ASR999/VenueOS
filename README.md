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

See [CLAUDE.md](./CLAUDE.md) for architecture, conventions, and the roadmap.
