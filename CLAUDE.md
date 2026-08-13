# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repo structure

This is a single monorepo (`origin` → `github.com/edulun/ChatApp`) containing four modules.
Three *previously* lived in their own git repo (`ChatApp-Client`, `ChatApp-Service`,
`ChatApp-Contracts` on GitHub under `edulun/`) — those remain on GitHub as historical/frozen
snapshots, but active development now happens here as one repo with one history:

| Module | Role |
|---|---|
| `ChatApp-Service` | Backend: Spring Boot, owns WebSocket + REST, persistence, presence |
| `ChatApp-Client` | Frontend: React/TS web client (scaffold only so far — see Status) |
| `ChatApp-Contracts` | Shared wire-format schemas consumed by both — the source of truth for the client/service boundary |
| `ChatApp-Migrations` | Applies Cassandra schema migrations as a one-shot deploy step — deliberately separate from `ChatApp-Service` (see its `DESIGN.md` §1) |

Read `DESIGN.md` at the root and inside each module before making architectural changes — these
are living design docs (not just historical context) and each ends with an "Open questions"
section that reflects real undecided points, not resolved ones. Root: `DESIGN.md`. Per-module:
`ChatApp-Service/DESIGN.md`, `ChatApp-Client/DESIGN.md`, `ChatApp-Contracts/DESIGN.md`,
`ChatApp-Migrations/DESIGN.md`.

## Status

- **`ChatApp-Service`**: real Spring Boot scaffold exists (builds and runs), but no
  controllers/handlers/entities have been implemented yet beyond the generated application class.
- **`ChatApp-Client`**: a bare `package.json` only (Nx + Vite + Vitest + ESLint + Prettier +
  TypeScript declared as devDependencies, `workspaces: ["packages/*"]`). No `nx.json`, no
  `packages/`, no `scripts` defined, no source code — the Nx workspace itself hasn't been
  generated yet. Don't assume any client build/lint/test command works until this scaffold exists.
- **`ChatApp-Contracts`**: schema files exist and are real (JSON Schema for REST/WebSocket,
  Protobuf for the Kafka-internal event) — see layout below — but no codegen tooling is wired up
  yet on either consuming side.
- **`ChatApp-Migrations`**: working and tested locally (`docker compose up -d` from
  `ChatApp-Service` + `./mvnw compile exec:java` from here applies `V1__initial_schema.cql`
  cleanly, confirmed idempotent on rerun). No containerized/CI packaging yet.

## Commands

### `ChatApp-Service` (Spring Boot, Java 21, Maven)

Local infra dependencies (Cassandra, Redis, Kafka) run in Docker; the service itself runs on the
host against them:

```
cd ChatApp-Service
docker compose up -d          # starts cassandra (+ a one-shot keyspace-init), redis, kafka
./mvnw spring-boot:run         # runs the service (mvnw.cmd on Windows cmd/PowerShell)
```

`application-local.yml` defaults match `docker-compose.yml` exactly, so no env vars are required
for local dev (`spring.profiles.default: local`). Staging/prod profiles (`application-staging.yml`,
`application-prod.yml`) always require `SPRING_PROFILES_ACTIVE` set explicitly.

```
./mvnw test                                            # all tests
./mvnw test -Dtest=ChatAppServiceApplicationTests       # single test class
./mvnw test -Dtest=ChatAppServiceApplicationTests#methodName  # single test method
./mvnw package                                          # build the jar (see Dockerfile for the containerized build)
```

Health check (once running): `GET /actuator/health` — `application.yml` restricts exposed
endpoints to `health` only, and `show-details` is only enabled on the `local` profile.

### `ChatApp-Client`

No scripts are defined yet (`package.json` has `"scripts": {}` and no Nx workspace has been
generated). Don't invent build/lint/test commands here — generate the workspace first if asked to
scaffold it, following the stack decisions in `ChatApp-Client/DESIGN.md` §2.

### `ChatApp-Contracts`

No build tooling yet. Per `ChatApp-Contracts/DESIGN.md` §6, the intended flow is: `ChatApp-Client`
generates TypeScript types from the JSON Schema files via `json-schema-to-typescript` at build
time, and `ChatApp-Service` generates Java types from the JSON Schema / `.proto` files at build
time — schemas here are never hand-copied into either consuming module.

### `ChatApp-Migrations` (plain Java 21, Maven — no Spring)

Applies Cassandra schema migrations. Run once per deploy, not embedded in `ChatApp-Service` —
see `ChatApp-Migrations/DESIGN.md` §1 for why. Against the standard local stack:

```
cd ChatApp-Service && docker compose up -d   # cassandra (+ keyspace init), redis, kafka
cd ../ChatApp-Migrations && ./mvnw compile exec:java
```

Reads `.cql` files from `migrations/` (not `src/main/resources/` — filesystem, not classpath, so
the same tool works unpackaged or from a future jar without a resource-scanning special case).
`CASSANDRA_HOST`/`PORT`/`DC`/`KEYSPACE` env vars, same names/defaults as `ChatApp-Service`'s
`application-local.yml`. Rerunning is a no-op once everything's applied — tracked in a
`schema_migrations` table it creates on first run.

## Architecture

### End-to-end message flow

```
Client --WS--> Service --produce--> Kafka(topic: chat.messages, key: room_id) --consume--> Cassandra
                  |
                  +--fan-out (real-time delivery to other room members, NOT gated on the Kafka/Cassandra write)--> Client(s)
```

- Kafka decouples the WebSocket write path from the DB write path; delivery to other connected
  clients happens independently of (and before) durability being confirmed.
- Kafka messages are keyed by `room_id` so per-room ordering is preserved without needing global
  ordering.
- Each message carries a client-generated ID used for both Kafka dedup and safe retry of sends.

### Data model (Cassandra)

No joins, so it's **one denormalized table per query pattern**, not a normalized relational
schema — e.g. `room_members_by_room` (list/check a room's members) and `rooms_by_user` (list a
user's rooms) are two tables for the same underlying membership fact, kept in sync at the
application level rather than via a join. `messages_by_room` partitions by `room_id` and clusters
by `(created_at DESC, id)`, which maps directly onto the `before=`/`after=` REST pagination
(`ChatApp-Service/DESIGN.md` §3.2) as a clustering-key range scan. Full table list and rationale:
`ChatApp-Service/DESIGN.md` §4.

### Presence, typing, and multi-instance routing (Redis)

- `presence:{user_id} -> {instance_id, last_heartbeat}` (TTL-based; key absence = offline).
- Typing state is short-TTL/pub-sub only — never persisted, never routed through Kafka.
- Cross-instance delivery: each service instance keeps one long-lived subscription to
  `route:{instance_id}`. To reach a user on another instance, the sending instance looks up their
  `instance_id` via the presence key and publishes to that instance's `route:` channel — chosen
  over a per-user channel since the instance count is small/stable. See
  `ChatApp-Service/DESIGN.md` §6 for the full rationale and the drop-if-stale behavior.

### Auth & sessions

- v1 identity: Google OAuth/OIDC only. `users` and `user_identities` are modeled as separate
  tables from the start (`provider_user_id` = Google's `sub`) so a future `provider = local` path
  is additive, not a migration.
- Sessions are **Redis-backed opaque tokens**, not self-contained JWTs — chosen specifically
  because Redis is already required infra and this gets cheap revocation (`DEL session:{id}`),
  which a JWT would need separate deny-list machinery for. The session ID is the bearer token
  value; no claims are encoded in it.
- The service-issued session credential (not the Google ID token) is what's used for both REST
  and the WebSocket handshake — delivered as a **bearer token** in the `/auth/google` response
  body, not a cookie. The client attaches it itself: `Authorization: Bearer <token>` on REST
  calls, and as the first WebSocket frame (`auth` event) immediately after connecting, since the
  browser `WebSocket` API can't set custom headers on the upgrade request. Kept in memory
  client-side (never `localStorage`), not the browser's automatic-cookie-attachment model. See
  `ChatApp-Service/DESIGN.md` §8 and `ChatApp-Client/DESIGN.md` §3.

### Reconnect / catch-up

Deliberately **client-driven, not a WebSocket protocol feature**: the client tracks the last-seen
message ID per room and, on reconnect, calls `GET /rooms/{id}/messages?after={lastSeenId}` to
backfill before resuming live delivery. Keeps the WebSocket protocol itself simple (no
resume/replay support needed).

### Contracts layout and consumption

```
ChatApp-Contracts/
  domain/     # User, Room, Message — $ref'd from rest/ and websocket/, not redefined there
  rest/       # REST request/response schemas (JSON Schema)
  websocket/  # WS message envelope schemas, one per event type (JSON Schema)
  kafka/      # chat-messages.proto — Protobuf, service-internal only (producer and consumer are both ChatApp-Service)
```

- REST/WebSocket use JSON Schema (client is non-JVM, so schema-first + generated types beats
  binary codegen tooling); Kafka uses Protobuf since that topic never leaves the service.
- **Compatibility policy is additive-only**: new fields are always optional, existing
  fields/enum-variants are never removed/renamed/retyped. There's no schema registry enforcing
  this — it's a review discipline. Flag any breaking schema change in review rather than assuming
  tooling will catch it.
- `domain/message.schema.json` intentionally omits a delivery-status field (pending/sent/failed)
  — that's client-local UI state, not part of the wire contract.

## Agents

Each module has its own project subagent, defined in that module's `.claude/agents/`:

| Subagent | Module | Scope |
|---|---|---|
| `client-dev` | `ChatApp-Client` | Implements client features. Never hand-writes DTOs; auth is a bearer token the client attaches itself, not a cookie. |
| `service-dev` | `ChatApp-Service` | Implements service features. Fan-out isn't gated on Kafka/Cassandra durability; sessions are Redis-backed opaque tokens, not JWTs; data model is one denormalized table per query, not relational. |
| `schema-reviewer` | `ChatApp-Contracts` | Read-only. Reviews schema diffs against the additive-only compatibility policy (§5 of that module's `DESIGN.md`) before merge. |
| `migrations-dev` | `ChatApp-Migrations` | Writes/runs Cassandra migrations. Never edits an already-applied migration file; every statement must be idempotent (no DDL transactions in Cassandra). |

Each is scoped to its own module's conventions and explicitly told not to reach across module
boundaries — a cross-module task (e.g. a new WebSocket event type) should be split so each
subagent only implements its side and states what the other modules need.

**Parallel work via worktrees**: even though this is one repo now, a feature that touches both
`ChatApp-Client` and `ChatApp-Service` can still be built by spawning one agent per module at the
same time, each isolated in its own git worktree of this repo (`isolation: "worktree"`), working
toward the same feature in parallel rather than serially. Run `schema-reviewer` first (or
alongside) on any `ChatApp-Contracts` change the feature depends on, since both other modules
generate their types from it.
