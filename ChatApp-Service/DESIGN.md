# ChatApp-Service — Design

See the [root system design](../DESIGN.md) for how this module fits with `ChatApp-Client` and
`ChatApp-Contracts`.

## Status

Design phase. No implementation yet — this document is the outline the implementation should
follow, and should be updated as decisions firm up or change.

## 1. Responsibilities

`ChatApp-Service` is the backend for the chat application. It owns:
- WebSocket connection lifecycle and authentication
- Real-time message routing between connected clients
- Room/conversation membership
- Presence and typing indicator state
- Durable message persistence (via Kafka → Cassandra)
- REST API for everything that isn't real-time (history, room management, auth)

## 2. Tech stack

- **Framework**: Spring Boot
- **Transport**: WebSockets (real-time), REST (everything else)
- **Durable store**: Cassandra
- **Queue**: Kafka, sitting between the WebSocket write path and Cassandra
- **Ephemeral store**: Redis, for presence, typing indicators, and (if multi-instance) session
  routing

## 3. API surface

### 3.1 WebSocket

One connection per authenticated client. Proposed message envelope (concrete schema belongs in
`ChatApp-Contracts` once decided):

| Type | Direction | Purpose |
|---|---|---|
| `auth` | client → server | Must be the first frame after connect; carries the bearer token (§8). Connection is held unauthenticated — no other message type accepted — until this validates. |
| `message.send` | client → server | Send a message to a room/conversation |
| `message.receive` | server → client | Deliver a message to every live connection for that room, including the sender's own (other tabs/devices, and the sending connection itself) — doubles as the sender's own send ack, see §5 |
| `typing.start` / `typing.stop` | client → server | Signal typing state |
| `typing.update` | server → client | Broadcast a peer's typing state |
| `presence.update` | server → client | A contact's online/offline status changed |
| `room.joined` / `room.left` | server → client | Membership change notification |

**Resolved** (see [`ChatApp-Client/DESIGN.md` §5](../ChatApp-Client/DESIGN.md#5-websocket-integration)):
the client tracks the last-received message ID per room and, on reconnect, calls
`GET /rooms/{id}/messages?after={lastSeenId}` to fill any gap before resuming live delivery.
The WebSocket protocol itself doesn't need resume/replay support — catch-up is entirely
client-driven via REST.

### 3.2 REST

| Endpoint (indicative) | Purpose |
|---|---|
| `POST /auth/google` | Exchange a Google ID token for a session (see §8) |
| `GET /rooms` | List the current user's rooms/conversations |
| `POST /rooms` | Create a room / start a 1:1 conversation |
| `GET /rooms/{id}/messages?before=&limit=` | Paginated message history (backward pagination) |
| `GET /rooms/{id}/messages?after=&limit=` | Catch-up after reconnect (see §3.1) |
| `POST /rooms/{id}/members` | Add a member to a group chat |

## 4. Data model (Cassandra)

Indicative schema — not final. Cassandra has no joins and no secondary lookups beyond a table's
own partition/clustering keys, so the model is **one denormalized table per query pattern**
rather than a normalized relational schema. **Schema is applied via
[`ChatApp-Migrations`](../ChatApp-Migrations/DESIGN.md), not by this service** —
`spring.cassandra.schema-action` is `none` everywhere, local included, deliberately, since running
schema changes from every app instance on boot risks concurrent-DDL schema disagreement
(`ChatApp-Migrations/DESIGN.md` §1). Locally, `ChatApp-Service/docker-compose.yml` runs
`ChatApp-Migrations` automatically before you'd ever start this service against it. The table set
below is mirrored in `ChatApp-Migrations/migrations/V1__initial_schema.cql` — keep both in sync:

```
users_by_id                  (id, display_name, created_at)
                              PK: id

user_identities_by_provider  (provider, provider_user_id, user_id, email, created_at)
                              PK: (provider, provider_user_id)
                              -- auth lookup: given Google's `sub`, find the user

rooms_by_id                  (id, type, name, created_at)
                              PK: id

room_members_by_room         (room_id, user_id, joined_at, role)
                              PK: room_id, CLUSTERING: user_id
                              -- "list/check members of a room" (message-send membership check, §5)

rooms_by_user                (user_id, room_id, joined_at, role)
                              PK: user_id, CLUSTERING: room_id
                              -- "list the current user's rooms" (GET /rooms) — a denormalized
                              -- copy of the same membership fact as room_members_by_room, since
                              -- Cassandra can't serve both access patterns from one table

messages_by_room             (room_id, created_at, id, sender_id, body)
                              PK: room_id, CLUSTERING: (created_at DESC, id)
                              -- id is still the client-generated dedup key from §5; created_at
                              -- (server-assigned) is the clustering column so before=/after=
                              -- pagination (§3.2) is a plain clustering-key range scan
```

Notes:
- This access pattern — append-mostly writes partitioned by room, read back as an ordered range
  scan over one partition — is close to Cassandra's ideal shape, more so than it was for
  PostgreSQL: no cross-room joins are ever needed, and per-room write/read load spreads naturally
  across partitions as room count grows.
- `rooms_by_id.type = direct` still covers 1:1 DMs as a degenerate 2-member room rather than a
  separate type (see original rationale — unchanged by the storage switch).
- `messages_by_room` is append-only. Edits/deletes are out of v1 scope (see root doc §9) but if
  added later, prefer a tombstone/soft-delete write over a Cassandra `UPDATE`/`DELETE` against
  historical rows, to keep the Kafka log and the table in agreement and avoid tombstone-heavy
  reads.
- No `kafka_offset` column: dedup is already solved by the client-generated message `id` (§5),
  Kafka's own consumer-group offsets already give replay-from-position independent of anything in
  Cassandra, and there's no second consumer of `chat.messages` planned that would need this
  correlation. Can be added later, additively, if a concrete need shows up.
- **Decision: accept the dual-write risk for v1** (resolves
  [#2](https://github.com/edulun/ChatApp/issues/2)). `room_members_by_room` and `rooms_by_user`
  duplicate the same membership fact for two different query shapes, and Cassandra has no
  cross-table transaction to keep a join/leave atomic across both. Write both inside a single
  logged `BATCH` — that gets atomicity of application (both writes eventually land, or the
  coordinator retries) but not isolation, so a reader can briefly see one table updated and not
  the other. Accepted for v1: membership changes are infrequent relative to messages, and a
  transient one-table-stale read (e.g. a `GET /rooms` that's a moment behind an in-flight join)
  is a low-consequence UI staleness, not a correctness bug. Revisit with a reconciliation job (or
  a rewrite onto a single source of truth for membership) only if drift between the two tables is
  actually observed, not preemptively.
- **Decision: `RF=3` with `LOCAL_QUORUM` reads/writes for any real (multi-node) deployment**
  (resolves [#3](https://github.com/edulun/ChatApp/issues/3)). This is the standard
  Cassandra-recommended default, not a number specific to this app's traffic: `RF=3` +
  `LOCAL_QUORUM` tolerates one node down per DC without losing availability or consistency
  (quorum of 3 is 2, survives 1 failure), and is the well-trodden starting point every Cassandra
  deployment guide converges on absent a specific reason to deviate. Local dev stays `RF=1`
  (single node — `LOCAL_QUORUM` there is equivalent to `ONE`, matching `docker-compose.yml`
  already). This is a placeholder-until-real-topology-exists decision, not a final answer: actual
  node count, DC layout, and read/write latency requirements aren't known yet since no real
  deployment target is chosen — revisit once one is.

## 5. Message write path

```
Client --WS--> Service --produce--> Kafka(topic: chat.messages, key: room_id) --consume--> Cassandra
                  |
                  +--fan-out (real-time delivery to other room members)--> Client(s)
```

- **Partitioning**: keyed by `room_id` so all messages in a room are consumed in order by a
  single partition/consumer, preserving per-room ordering without requiring global ordering —
  matches `messages_by_room`'s own partitioning (§4), so a room's Kafka ordering and its stored
  ordering agree.
- **Fan-out vs. persistence are decoupled**: real-time delivery — to every live connection for
  the room, sender included (§3.1) — does not wait on the Kafka → Cassandra write. This keeps
  latency low but means a message can be delivered before it's durable. `message.receive`
  reaching the sender is what the client treats as "sent" (`ChatApp-Client/DESIGN.md` §7); note
  that's "accepted and fanned out," not "durably persisted" — there's no `message.failed`-style
  event yet for the rarer case where the later Cassandra write actually fails, so that failure
  mode isn't currently surfaced to the client at all. Deferred rather than solved: Kafka's own
  durability/retry behavior makes a genuine permanent write failure rare enough that this gap is
  acceptable for v1, but it's a real gap, not a resolved one — revisit if it's ever observed in
  practice.
- **Dedup**: each message gets a client-generated ID (e.g. UUID) at send time, used both for
  Kafka dedup and so retried sends don't create duplicates.

**Decision: at-least-once delivery, not exactly-once** (resolves
[#1](https://github.com/edulun/ChatApp/issues/1)). Per-room ordering is already guaranteed by the
`room_id`-keyed partitioning above; what's left open is duplicate delivery under retry/failure,
and at-least-once + client-side dedup by message `id` (already designed in) is enough — a
duplicate `message.send` retry produces the same `id`, so both `messages_by_room`'s primary key
and the client's own rendering can drop the repeat. Exactly-once would mean Kafka transactions
end-to-end (producer + the Cassandra-writing consumer), which is real added complexity with no
concrete v1 requirement driving it — chat UX tolerates an occasional client-visible duplicate far
better than it tolerates added write latency. Revisit only if a real duplicate-message bug
surfaces that dedup-by-id doesn't actually catch.

## 6. Presence & typing (Redis)

- **Presence**: `presence:{user_id} -> {instance_id, last_heartbeat}` with a TTL; absence of the
  key means offline. Client heartbeats keep it alive over the open WebSocket.
- **Typing**: short TTL keys or pub/sub events per `(room_id, user_id)` — not persisted, not
  routed through Kafka.
- **Multi-instance routing — Redis pub/sub, per instance**: each service instance subscribes,
  for its whole lifetime, to a Redis Pub/Sub channel unique to itself: `route:{instance_id}`.
  This pairs directly with the presence key above, which already records which instance holds a
  given user's connection.

  Delivery flow when Instance A needs to get a message to User X, connected on Instance B:
  1. Instance A reads `presence:{user_id=X}` to get `instance_id = B`.
  2. Instance A publishes `{user_id: X, payload: <event>}` to `route:B`.
  3. Instance B, already subscribed to `route:B`, receives it, looks up X in its local
     in-memory connection registry, and pushes the payload down that WebSocket.
  4. If Instance B no longer holds a live connection for X (a disconnect raced the presence
     lookup), the event is simply dropped for real-time delivery — acceptable, since the
     message is already durable via Kafka (§5) and will surface through the REST catch-up path
     (§3.1) regardless.

  Chosen over a per-user channel (`deliver:{user_id}`) because the number of instances is small
  and stable — one persistent subscription per instance for its whole lifetime — versus a
  per-user design where every instance would need to subscribe/unsubscribe on every connect/
  disconnect, for no benefit given presence already tells you exactly which instance to target.

## 7. Group chats vs. direct messages

Modeled uniformly as `rooms_by_id` (see §4). Group-specific concerns:

**Decision: no admin/moderation roles, no membership audit trail, for v1** (resolves
[#4](https://github.com/edulun/ChatApp/issues/4)). `room_members_by_room`/`rooms_by_user` already
carry a `role` column (§4), but nothing reads or enforces it yet — any member can add/remove
members for v1, there's no distinct "owner"/"admin" behavior, and add/remove events aren't
logged anywhere beyond the current membership state. Same reasoning as dropping `kafka_offset`
(§4) and not adding a `schemaVersion` field (`ChatApp-Contracts/DESIGN.md` §5): no concrete
requirement driving either yet, and both are additive to bring in later — moderation roles as new
enforcement logic reading the existing `role` column, an audit trail as a new table fed by the
same join/leave write path. Revisit once an actual moderation/abuse scenario in a real group
chat makes the gap concrete rather than hypothetical.

## 8. Auth

**v1**: OAuth 2.0 / OIDC via Google as the sole identity provider. No native username/password
account creation initially — every user is provisioned from a Google identity on first login.

**Future**: add native account creation (email/password or similar) as a second path. Design the
identity model now so it doesn't assume Google is the only source later — per §4:

```
users_by_id                  (id, display_name, created_at, ...)
user_identities_by_provider  (provider, provider_user_id, user_id, email, created_at)
```

`provider_user_id` is Google's `sub` claim for `provider = google`, and `(provider,
provider_user_id)` is the table's partition key — the exact lookup auth needs. Keeping identity as
a separate table from `users_by_id` means adding `provider = local` later (password-based) is an
additive new table, not a migration of existing rows.

**Flow (v1)**:
1. Client performs the Google OAuth/OIDC flow (authorization code, PKCE) and obtains an ID
   token from Google.
2. Client sends that ID token to the service (e.g. `POST /auth/google`).
3. Service verifies the token against Google's public keys, looks up or creates the
   `user_identities_by_provider` row (+ `users_by_id` row on first login, per §4), and issues its
   own session credential (session token/JWT) back to the client.
4. That service-issued credential — not the Google token — is what's used for both the REST API
   and the WebSocket handshake. Delivered as a **bearer token in the `/auth/google` response
   body** (per [`ChatApp-Client/DESIGN.md` §3](../ChatApp-Client/DESIGN.md#3-auth-flow-google-oauth)),
   not a cookie: the client attaches it itself via `Authorization: Bearer <token>` on REST calls.
   For the WebSocket handshake — where the browser can't set custom headers — the client instead
   sends the token as the first frame after connecting (the `auth` event, §3.1); the service must
   hold the connection unauthenticated, accepting only that one message type, until the token
   validates, and close it if `auth` doesn't arrive within a short timeout. Choosing a token over
   a cookie here means this same delivery mechanism already works for a future non-browser
   client, rather than needing a second mechanism later.

**Session storage — Redis-backed opaque session, decided over a self-contained JWT**:
- On successful token exchange (step 3 above), the service generates a cryptographically random
  opaque session id (e.g. 256-bit, base64url-encoded) and stores
  `session:{session_id} -> {user_id, created_at, last_seen_at}` in Redis with a TTL.
- The session id itself — no encoded claims — is the bearer `token` value delivered to the
  client in the `/auth/google` response body (§8 item 4).
- Every authenticated request resolves the user via `GET session:{session_id}`. TTL is a
  sliding window: refreshed on activity, but only when the remaining TTL has dropped below some
  threshold (e.g. under half its original value) rather than on every single request, to avoid
  a Redis write per hit.
- Revocation is a plain `DEL session:{session_id}` — trivial logout. A secondary index
  `user_sessions:{user_id} -> {session_id, ...}` would additionally enable "sign out
  everywhere" / forced revocation (e.g. suspected compromise), if that turns out to be needed.
- Chosen over a JWT specifically because Redis is already required infrastructure (presence,
  routing) and this buys cheap revocation, which a self-contained JWT doesn't provide without
  its own deny-list machinery — i.e. the JWT's usual advantage (no storage lookup) isn't worth
  much here since a lookup is already unavoidable per request.

**Decision: 30-day sliding TTL, refreshed once under half its remaining value; no "sign out
everywhere" for v1** (resolves [#5](https://github.com/edulun/ChatApp/issues/5)). 30 days matches
ordinary "stay signed in" expectations for a chat app (not a banking-app-style short session), and
the refresh-under-50%-remaining threshold was already the sliding-window mechanism designed above
— this just picks the number. `user_sessions:{user_id}` (the secondary index "sign out
everywhere" needs) isn't built for v1: nothing in v1 scope (no admin/moderation per §7, no
credential-compromise flow) currently needs to force-revoke a session other than the one being
used, so there's no consumer for it yet. Purely additive to add later — a new secondary index
alongside the existing `session:{session_id}` keys, not a migration of them. These are product
defaults, not derived from any load/security analysis — revisit if real usage suggests otherwise.

**Decision: connect-time-only validation, not periodic re-validation** (resolves
[#6](https://github.com/edulun/ChatApp/issues/6)). The `auth` frame (§3.1) validates once, when
the WebSocket connects; a revoked session doesn't force-close an already-open connection before
its next reconnect. Acceptable because: `DEL session:{session_id}` (this section) already blocks
all *new* activity — REST calls fail immediately, and a fresh WebSocket connect fails at the
`auth` frame — so the exposure window is "how long can an already-open connection outlive a
revocation," not "can revocation be bypassed entirely." And since "sign out everywhere" isn't v1
(above), the only realistic revocation path for now is the user's own logout on the same
device/tab, where the WebSocket naturally closes anyway. Revisit if "sign out everywhere" or a
compromise-response flow becomes real — that's exactly the scenario where an attacker's still-open
connection outliving revocation actually matters.

**Decision: the bearer token is a 1:1 stand-in for the session ID, no separate client-side
expiry/refresh** (resolves [#11](https://github.com/edulun/ChatApp/issues/11)). The token *is*
the `session_id` (already stated above — "no encoded claims"), so it has no independent lifecycle
to manage: it's valid exactly as long as the Redis session is, and the client doesn't need to
reason about token expiry as a concept distinct from "the session expired." On a `401` (session
missing/expired in Redis), the client simply treats it as signed-out and re-runs the Google OAuth
flow (`ChatApp-Client/DESIGN.md` §3) to get a new one — there's no refresh-token exchange to
build. Simpler than independent token expiry, and consistent with choosing an opaque Redis-backed
session over a self-contained JWT in the first place (this section, above).

## 9. Rate limiting & abuse prevention (recommendation)

Not yet implemented; Redis is already present, which makes distributed rate limiting cheap to
add without new infra (e.g. via Bucket4j's Redis backend, or hand-rolled token buckets).
Proposed layers, roughly in priority order for v1:

1. **Per-user WebSocket send limit** — token bucket on `message.send` (e.g. N messages per 10s
   per user). Rejects over-limit sends with an error frame. Covers the most likely abuse vector
   (message flooding a room).
2. **REST rate limiting** — per-user (per-IP for the pre-auth `/auth/google` endpoint) limits
   applied broadly, stricter on writes (`POST /rooms`, `POST /rooms/{id}/members`) than reads.
3. **Message size cap** — reject oversized `message.send` payloads outright, before they reach
   rate-limit or Kafka-produce logic. Cheapest possible check.
4. **Connection cap** — limit concurrent WebSocket connections per user (and optionally per IP),
   so a single actor can't sidestep per-connection limits by opening many sockets.
5. **Room/membership creation limits** — separate, lower-throughput caps on `POST /rooms` and
   `POST /rooms/{id}/members`, since spam-room creation is a distinct abuse pattern from message
   flooding.

Recommend starting with (1) + (2) + (3) for v1 — cheapest to build and covers the dominant risk
(message flooding) — and treating (4)/(5) as follow-ups if actually observed. User-level
blocking/reporting and signup-side throttling are longer-term and out of scope per the root
doc's non-goals; Google OAuth as the only signup path already raises the bar somewhat versus
open registration.

**Decision: starting thresholds for (1)–(3)** (resolves
[#7](https://github.com/edulun/ChatApp/issues/7)), picked as reasonable chat-app defaults rather
than derived from any real traffic data — the point is to have *a* number in place, not the
*right* number, since there's none of the latter without production traffic to look at:

1. **Per-user `message.send`**: 10 messages / 10s (token bucket), refilling continuously —
   generous for real typing/sending speed, well below flood-bot territory.
2. **REST**: 60 requests/min per authenticated user on reads; 20/min on writes (`POST /rooms`,
   `POST /rooms/{id}/members`); 10/min per IP on the pre-auth `POST /auth/google`.
3. **Message size cap**: 8 KiB per `message.send` body — comfortably above any real chat message,
   cheap to check before it reaches Kafka.

Every number here is explicitly a starting default, not a tuned one — revisit once real usage
data exists rather than trying to guess right the first time.

## 10. Open questions (service-specific)

None as of this writing — the items formerly here (rate-limit thresholds, session TTL/"sign out
everywhere", WebSocket periodic re-validation, `room_members_by_room`/`rooms_by_user`
consistency, Cassandra replication factor) are now **Decision** notes in §4, §5 (write path), §7,
§8, and §9 respectively. Several are explicitly-placeholder defaults rather than final answers
(flagged as such inline) — add new items here as they come up, don't treat this section staying
empty as "nothing left to decide."
