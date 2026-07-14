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
| notifications | 4004 | (queue only)     | consumes `booking.confirmed` from RabbitMQ |

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
- Demo the async path: `POST http://localhost:8080/api/booking/test-event`,
  then `docker compose logs notifications`

## Conventions

- Services are plain JavaScript, CommonJS, Express; entry point `src/index.js`.
  Client is ESM/React. No TypeScript for now.
- All config via environment variables (set in docker-compose.yml); no
  hardcoded hosts/ports/credentials.
- Every service exposes `GET /health` reporting its own dependencies.
- One Postgres container, but separate databases per service (`booking`,
  `payment`) — created in `infra/postgres/init.sql`. Schema/migrations live
  with the owning service (tooling comes in Phase 1).

## Roadmap

1. **Phase 1** — booking domain: events/seats schema, seat holds with Redis
   TTL, bookings with a chosen locking strategy, mock payment flow, real
   `booking.confirmed` events. Write DESIGN.md before starting.
2. **Phase 2** — caching, rate limiting, k6 load tests against the locking
   strategy.
3. **Phase 3** — outbox pattern, idempotent consumers, search.
4. **Phase 4** — AWS Free Plan deploy: EC2 + (ECS or k3s), SQS, Terraform,
   Prometheus/Grafana, CI/CD deploys.
