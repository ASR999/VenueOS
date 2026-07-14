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

See [CLAUDE.md](./CLAUDE.md) for architecture, conventions, and the roadmap.
