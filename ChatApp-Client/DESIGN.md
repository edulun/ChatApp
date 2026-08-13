# ChatApp-Client — Design

See the [root system design](../DESIGN.md) for how this module fits with `ChatApp-Service` and
`ChatApp-Contracts`.

## Status

Design phase. No implementation yet.

## 1. Responsibilities

`ChatApp-Client` is the end-user web application. It owns:
- Google OAuth sign-in flow
- Rendering conversations (1:1 and group), sending/receiving messages in real time
- Presence and typing indicator display
- Message history loading/pagination

## 2. Tech stack

| Concern | Choice |
|---|---|
| Platform | Web (browser) |
| Language/framework | React + TypeScript |
| Build tool | Vite — standard pairing with React + TS, fast dev loop |
| State management | Redux Toolkit (see §4 for why, over a lighter store) |
| REST data fetching | RTK Query — generated from the REST DTO schemas in `ChatApp-Contracts` |
| WebSocket handling | Custom Redux middleware (§5) |
| Contracts consumption | Types generated from `ChatApp-Contracts` JSON Schemas via
  `json-schema-to-typescript` at build time (see [`ChatApp-Contracts/DESIGN.md`
  §6](../ChatApp-Contracts/DESIGN.md#6-how-each-side-consumes-this)) — no hand-written duplicate
  DTOs |

## 3. Auth flow (Google OAuth)

1. Client uses Google Identity Services (GIS) JS SDK to run the sign-in flow and obtain a Google
   ID token — no server round-trip needed for this step.
2. Client `POST`s the ID token to the service (`/auth/google`, per
   [`ChatApp-Service/DESIGN.md` §8](../ChatApp-Service/DESIGN.md#8-auth)).
3. Service verifies it and returns a session credential — a bearer `token`, in the response body
   (`ChatApp-Contracts/rest/auth-google.response.schema.json`) — plus the `user` profile.

**Decision: token-based, not a cookie.** The client holds the credential itself and attaches it
as `Authorization: Bearer <token>` on every REST call, rather than an httpOnly cookie the browser
attaches automatically. Chosen so the same credential-handling path works unchanged for a future
non-browser client, at the cost of the token being reachable from JS (an httpOnly cookie isn't) —
mitigated by keeping it in memory only (the `auth` Redux slice, §4), never `localStorage`/
`sessionStorage`, so it doesn't survive a page reload and isn't a durable XSS exfiltration target.
RTK Query's `fetchBaseQuery` needs a `prepareHeaders` that reads the token from the `auth` slice
and sets the header — this doesn't happen automatically the way cookie attachment did.

**WebSocket handshake**: the browser `WebSocket` API can't set custom headers on the upgrade
request, so the token can't ride along the way a cookie could. Instead, per
`ChatApp-Contracts/websocket/auth.schema.json`: the client opens the socket, then sends an `auth`
message carrying the token as the *first* frame, before anything else. The service holds the
connection unauthenticated until that validates (see
[`ChatApp-Service/DESIGN.md` §3.1](../ChatApp-Service/DESIGN.md#31-websocket)).

## 4. State management — why Redux Toolkit over a lighter store

Chosen over a minimal store (Context/hooks, Zustand) because the client has three concurrent
real-time streams feeding shared state (messages, presence, typing) on top of REST-fetched data
(room list, history) — Redux Toolkit's single store + RTK Query's cache normalization keeps
"which slice owns this data" unambiguous as that grows, and its middleware pattern is a natural
fit for translating inbound WebSocket events into store updates (§5). Revisit if the app's actual
complexity ends up not justifying the boilerplate.

Proposed slices:

| Slice | Owns |
|---|---|
| `auth` | Current user, sign-in status |
| `roomsApi` (RTK Query) | Room list, membership — REST-backed |
| `messagesApi` (RTK Query) + `messages` | Paginated history (REST) merged with live inbound messages (WebSocket) per room |
| `presence` | Online/offline status per contact |
| `typing` | Ephemeral typing state per room |

## 5. WebSocket integration

A Redux middleware owns the single WebSocket connection's lifecycle:
- Connects after successful auth (§3), then immediately sends the `auth` frame (token from the
  `auth` slice) before anything else — see §3's WebSocket handshake note.
- Maps each inbound message (typed per the envelope in
  [`ChatApp-Contracts/DESIGN.md` §2](../ChatApp-Contracts/DESIGN.md#2-what-lives-here)) to a
  corresponding Redux action — `message.receive` → append to `messages`, `presence.update` →
  update `presence`, `typing.update` → update `typing`, etc.
- Owns reconnect/backoff on drop.

**Reconnect/catch-up (resolves the open question in [`ChatApp-Service/DESIGN.md`
§3.1](../ChatApp-Service/DESIGN.md#31-websocket))**: the client tracks the last-received message
ID per room. On reconnect, before resuming live delivery, it calls the REST history endpoint
(`GET /rooms/{id}/messages?after={lastSeenId}`) per room to fill any gap, then switches back to
live WebSocket updates. This keeps catch-up logic entirely client-side and REST-based, rather
than needing the WebSocket protocol itself to support resume/replay.

## 6. Directory layout (proposed)

```
ChatApp-Client/
  src/
    api/            # RTK Query slices (rooms, messages, auth)
    ws/             # WebSocket middleware + connection lifecycle
    features/       # auth, presence, typing slices
    components/     # UI
    generated/      # types generated from ChatApp-Contracts schemas — not hand-edited
```

## 7. Open questions

- **Still open** ([#8](https://github.com/edulun/ChatApp/issues/8)): exact Redux slice boundaries
  above are a first pass. This one genuinely can't be resolved by design decision alone — it
  needs message pagination and live updates actually implemented together before it's clear
  whether the boundaries hold up. Revisit then, not now.

- **Decision** (resolves [#9](https://github.com/edulun/ChatApp/issues/9)): `room.joined`/
  `room.left` **manually patch the RTK Query cache** via `roomsApi.util.updateQueryData`, rather
  than relying on tag invalidation. Invalidation is a pull model — it marks a cache entry stale
  and waits for the next subscriber-triggered refetch — which fits REST-driven mutations, not a
  server-pushed event that already carries the full new membership data. Patching directly with
  what the event already contains is lower latency (no extra round trip for data already in
  hand) and simpler than reasoning about when invalidation would actually re-fetch.

- **Decision** (resolves [#10](https://github.com/edulun/ChatApp/issues/10)): **optimistic send
  with a `pending` state.** On `message.send`, append the message to `messages` immediately using
  the client-generated `id` (`ChatApp-Service/DESIGN.md` §5) with `status: 'pending'` — don't wait
  for a round trip. Per `ChatApp-Service/DESIGN.md` §3.1/§5, `message.receive` is fanned out to
  the sender's own connection too, specifically so it can serve as the send ack: when an inbound
  `message.receive` arrives whose `message.id` matches a locally-pending entry, transition that
  entry to `status: 'sent'` in place rather than appending a duplicate. Note what "sent" means
  here — accepted and fanned out, not durably persisted (`ChatApp-Service/DESIGN.md` §5) — there's
  currently no event for the rarer later-Cassandra-write-failure case, so a message can't
  currently transition to `failed` at all. `status` here is local-only client state, consistent
  with `domain/message.schema.json` deliberately excluding it from the wire contract.

- **Decision** (resolves [#11](https://github.com/edulun/ChatApp/issues/11), see
  `ChatApp-Service/DESIGN.md` §8 for the full reasoning): the bearer token is a 1:1 stand-in for
  the Redis session — no separate client-side expiry/refresh logic. A `401` means "treat as
  signed out," full stop; the client re-runs the Google OAuth flow (§3) rather than attempting
  any kind of token refresh.
