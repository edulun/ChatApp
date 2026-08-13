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
- Durable message persistence (via Kafka → PostgreSQL)
- REST API for everything that isn't real-time (history, room management, auth)

## 2. Tech stack

- **Framework**: Spring Boot
- **Transport**: WebSockets (real-time), REST (everything else)
- **Durable store**: PostgreSQL
- **Queue**: Kafka, sitting between the WebSocket write path and PostgreSQL
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
| `message.receive` | server → client | Deliver a message from another participant |
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

## 4. Data model (PostgreSQL)

Indicative schema — not final:

```
users            (id, username, ...)
rooms            (id, type [direct|group], name, created_at)
room_members     (room_id, user_id, joined_at, role)
messages         (id, room_id, sender_id, body, created_at)
```

Notes:
- `rooms.type = direct` covers 1:1 DMs as a degenerate 2-member room, rather than modeling DMs
  separately — avoids duplicating room/membership logic. Revisit if DM-specific behavior
  diverges enough to justify a split.
- `messages` is append-only. Edits/deletes are out of v1 scope (see root doc §9) but if added
  later, prefer soft-delete/tombstone events over mutation, to keep the Kafka log and DB in
  agreement.
- No `kafka_offset` column: the original idea was to let a stored row be correlated back to a
  Kafka seek point for replay/debugging. Dropped because dedup is already solved by the
  client-generated message ID (§5), Kafka's own consumer-group offsets already give
  replay-from-position independent of anything in Postgres, and there's no second consumer of
  `chat.messages` planned that would need this correlation. Can be added later, additively, if
  a concrete need shows up.

## 5. Message write path

```
Client --WS--> Service --produce--> Kafka(topic: chat.messages, key: room_id) --consume--> Postgres
                  |
                  +--fan-out (real-time delivery to other room members)--> Client(s)
```

- **Partitioning**: keyed by `room_id` so all messages in a room are consumed in order by a
  single partition/consumer, preserving per-room ordering without requiring global ordering.
- **Fan-out vs. persistence are decoupled**: real-time delivery to other connected clients does
  not wait on the Kafka → Postgres write. This keeps latency low but means a message can be
  delivered before it's durable. Acceptable for chat UX, but flag to the client via a
  `pending`/`sent`/`failed` status if the write later fails, so the UI doesn't lie about
  durability.
- **Dedup**: each message gets a client-generated ID (e.g. UUID) at send time, used both for
  Kafka dedup and so retried sends don't create duplicates.

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

Modeled uniformly as `rooms` (see §4). Group-specific concerns:
- Membership changes (add/remove) need their own audit trail if that becomes a requirement —
  not in v1.
- No admin/moderation roles specified yet — open question if group chats need them for v1.

## 8. Auth

**v1**: OAuth 2.0 / OIDC via Google as the sole identity provider. No native username/password
account creation initially — every user is provisioned from a Google identity on first login.

**Future**: add native account creation (email/password or similar) as a second path. Design the
`users` table now so it doesn't assume Google is the only identity source later:

```
users            (id, display_name, created_at, ...)
user_identities  (id, user_id, provider [google|local], provider_user_id, email, created_at)
```

`provider_user_id` is Google's `sub` claim for `provider = google`. Keeping identity as a
separate table from `users` means adding `provider = local` later (password-based) is an
additive change, not a migration of existing rows.

**Flow (v1)**:
1. Client performs the Google OAuth/OIDC flow (authorization code, PKCE) and obtains an ID
   token from Google.
2. Client sends that ID token to the service (e.g. `POST /auth/google`).
3. Service verifies the token against Google's public keys, looks up or creates the
   `user_identities` row (+ `users` row on first login), and issues its own session credential
   (session token/JWT) back to the client.
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

**Remaining open questions**:
- Exact TTL duration (product decision, not architectural).
- Whether "sign out everywhere" is a v1 requirement (determines if `user_sessions:{user_id}` is
  needed now or can be added later).
- Whether the WebSocket handshake re-validates the credential per-connection only, or also
  periodically for long-lived connections.

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

## 10. Open questions (service-specific)

- Exact rate-limit thresholds in §9 — the layers are proposed, the numbers aren't.
- Session TTL duration and whether "sign out everywhere" is needed for v1 (§8)
- Whether the WebSocket handshake re-validates the session credential periodically on long-lived
  connections, or only at connect time (§8)
