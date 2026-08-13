# ChatApp

A real-time chat application supporting direct messages and group chats, with message
durability, presence, and typing indicators.

## Modules

| Module | Role |
|---|---|
| [`ChatApp-Service`](ChatApp-Service) | Backend (Spring Boot). Owns connection handling, auth, routing, presence, and message persistence. |
| [`ChatApp-Client`](ChatApp-Client) | End-user client application. Connects to the service over WebSockets, renders conversations, sends/receives messages. |
| [`ChatApp-Contracts`](ChatApp-Contracts) | Shared message/event schemas used by both client and service so the wire format has a single source of truth. |
| [`ChatApp-Migrations`](ChatApp-Migrations) | Applies Cassandra schema migrations as a one-shot deploy step, separate from `ChatApp-Service`. |

See [`DESIGN.md`](DESIGN.md) for the full system design, and each module's own `DESIGN.md` for
module-specific detail.

## v1 feature scope

- 1:1 direct messaging
- Group chats / rooms
- Presence (online/offline) and typing indicators
- Message history, persisted and paginated

## Tech stack

| Concern | Choice |
|---|---|
| Service framework | Spring Boot (Java 21) |
| Client | React + TypeScript + Vite |
| Real-time transport | WebSockets |
| Durable storage | Cassandra |
| Message queue | Kafka |
| Presence / ephemeral state | Redis |
| Contracts | JSON Schema (REST/WebSocket) + Protobuf (Kafka) |

## Getting started

`ChatApp-Service` has a runnable scaffold:

```
cd ChatApp-Service
docker compose up -d      # local Cassandra + schema migrations (both automatic), Redis, Kafka
./mvnw spring-boot:run
```

`docker compose up -d` builds and runs [`ChatApp-Migrations`](ChatApp-Migrations) automatically
once Cassandra's ready — no separate step needed for local dev. See
[`ChatApp-Migrations/DESIGN.md`](ChatApp-Migrations/DESIGN.md) for running it manually (e.g.
against a non-local cluster) or iterating on a new migration.

`ChatApp-Client` is design-only so far — see [`ChatApp-Client/DESIGN.md`](ChatApp-Client/DESIGN.md).

## License

GPL v3 — see [`LICENSE.md`](LICENSE.md).
