# ChatApp-Contracts — Design

See the [root system design](../DESIGN.md) for how this module fits with `ChatApp-Client` and
`ChatApp-Service`.

## Status

Design phase. No schemas exist yet — this document is the outline to implement against.

## 1. Purpose

Single source of truth for everything that crosses the Client ↔ Service boundary (and the
Service ↔ Kafka boundary), so the wire format isn't defined twice and can't silently drift.
`ChatApp-Client` is **non-JVM**, so contracts can't be shared as compiled code — they're shared
as schemas that each side generates/validates against independently.

## 2. What lives here

Per the earlier scope decision, four things:

1. **Domain model types** — `User`, `Room`, `Message`, etc. — the shared vocabulary the other
   three categories are built from.
2. **REST DTOs** — request/response bodies for the endpoints in
   [`ChatApp-Service/DESIGN.md` §3.2](../ChatApp-Service/DESIGN.md#32-rest).
3. **WebSocket message envelope** — the event types from
   [`ChatApp-Service/DESIGN.md` §3.1](../ChatApp-Service/DESIGN.md#31-websocket)
   (`auth`, `message.send`, `typing.start`, `presence.update`, ...).
4. **Kafka event schemas** — the `chat.messages` event that flows from the WebSocket write path
   into Cassandra ([`ChatApp-Service/DESIGN.md` §5](../ChatApp-Service/DESIGN.md#5-message-write-path)).

## 3. Format — recommendation

"Schema-first" was the direction, but REST/WebSocket and Kafka have different audiences and
should probably use different tools rather than forcing one format everywhere:

| Surface | Audience | Proposed format | Why |
|---|---|---|---|
| REST + WebSocket | Client (non-JVM) + Service | **JSON Schema** | Wire format is JSON either way; JSON Schema documents/validates that shape without imposing binary codegen tooling on a web/mobile client. Every mainstream client stack consumes JSON natively. |
| Kafka (`chat.messages`) | Service-internal only (producer and consumer are both `ChatApp-Service`) | **Protobuf** | Never touched by the client, so binary efficiency and Protobuf's built-in field-numbering rules (which map directly onto the additive-only policy in §5) are pure upside with no client-tooling cost. |

**Open question**: is running two schema formats worth the consistency cost, or should
everything just be JSON Schema (including Kafka) until there's a concrete reason to optimize the
internal path? Default to JSON Schema everywhere if the team would rather keep one toolchain,
and revisit Protobuf for Kafka only if message volume makes it worth it.

## 4. Layout (implemented)

```
ChatApp-Contracts/
  domain/
    user.schema.json
    room.schema.json
    message.schema.json
  rest/
    error.schema.json                    # common envelope, not tied to one endpoint
    auth-google.request.schema.json
    auth-google.response.schema.json
    list-rooms.response.schema.json
    create-room.request.schema.json
    create-room.response.schema.json
    list-messages.response.schema.json   # shared by ?before= and ?after=
    add-room-member.request.schema.json
    add-room-member.response.schema.json
  websocket/
    auth.schema.json                     # must be the first client frame after connect
    message-send.schema.json
    message-receive.schema.json
    typing.schema.json                   # covers both typing.start and typing.stop
    typing-update.schema.json
    presence-update.schema.json
    room-joined.schema.json
    room-left.schema.json
  kafka/
    chat-messages.proto
```

Domain schemas (`domain/`) are `$ref`-ed from the REST and WebSocket schemas rather than
redefined, so `Message` has one definition even though it appears in a REST response and a
WebSocket event. Kafka's `ChatMessageEvent` is a separate Protobuf message rather than a `$ref`
(per §3, it's a different format), but its fields intentionally mirror `domain/message.schema.json`
field-for-field.

Two calls made while generating these that weren't previously decided:
- `rest/error.schema.json` — a common `{ error: { code, message } }` envelope, added since every
  REST endpoint needs *some* error shape and none had been specified.
- `domain/message.schema.json` deliberately does **not** include a delivery-status field
  (pending/sent/failed, per [`ChatApp-Service/DESIGN.md`
  §5](../ChatApp-Service/DESIGN.md#5-message-write-path)) — that stays client-local UI state
  ([`ChatApp-Client/DESIGN.md` §4](../ChatApp-Client/DESIGN.md#4-state-management--why-redux-toolkit-over-a-lighter-store)),
  not a wire contract, since how a failure gets communicated back to the client isn't designed
  yet.
- `websocket/auth.schema.json` — added when auth moved from a cookie to a client-held bearer
  token ([`ChatApp-Client/DESIGN.md` §3](../ChatApp-Client/DESIGN.md#3-auth-flow-google-oauth)):
  the browser `WebSocket` API can't set custom headers on the upgrade request, so the token has
  to travel as the first message frame instead. `rest/auth-google.response.schema.json` gained a
  `token` field for the same reason.

## 5. Versioning & compatibility policy

**Additive-only / backward compatible**, no schema registry for now:

- New fields are always optional (JSON Schema: not in `required`; Protobuf: new field number,
  never reuse an old one).
- Existing fields are never removed, renamed, or retyped. If a field is truly obsolete, mark it
  deprecated in a comment and stop populating it — don't delete it from the schema while any
  deployed client might still read it.
- Enums (e.g. WebSocket event `type`, room `type`) are treated the same way: adding a new
  variant is safe, removing one isn't.
- Because there's no registry enforcing this automatically yet, compatibility is a review
  discipline, not a tooling guarantee. Revisit if breakages start slipping through.

**Decision: no explicit `schemaVersion` field on domain types, for now** (resolves
[#13](https://github.com/edulun/ChatApp/issues/13)). The additive-only policy above already
provides the compatibility guarantee a version field is normally used for — a consumer on an
older schema just doesn't know about a new field yet, and a `$ref`-ed domain type never has a
field removed out from under it. Adding a version field now, with no concrete consumer for it
(no analytics pipeline bucketing by version, no client gate rejecting old servers), would be
speculative — the same reasoning already applied to dropping `kafka_offset` from
`messages_by_room` (`ChatApp-Service/DESIGN.md` §4). This isn't a one-way door: adding it later is
itself just an additive optional field, whenever a real need for it shows up (e.g. long-lived
clients that can't assume they're always talking to a compatible server, or an actual breaking
change that needs a discriminator).

## 6. How each side consumes this

- **`ChatApp-Service` (JVM)**: generate Java types from the JSON Schema / `.proto` files at
  build time rather than hand-writing DTOs that can drift from the schema.
- **`ChatApp-Client` (React + TypeScript, per [`ChatApp-Client/DESIGN.md`
  §2](../ChatApp-Client/DESIGN.md#2-tech-stack))**: generate TS types from the JSON Schemas via
  `json-schema-to-typescript` at build time, landing in a `generated/` directory that's never
  hand-edited.
- Either way, the schema files in this module are the build input on both sides — nobody
  hand-maintains a parallel copy of the shape.

## 7. Open questions

- Single vs. dual schema format (§3) — leaning dual (JSON Schema for client-facing, Protobuf for
  Kafka) but not committed.
- Where generated code lands — committed to the repo vs. generated at build time in each
  consuming module.
