-- V1: initial schema, per ChatApp-Service/DESIGN.md §4.
-- Indicative — expected to evolve. Each statement is IF NOT EXISTS: migrations must be safely
-- re-runnable, since Cassandra DDL isn't transactional (see DESIGN.md).

CREATE TABLE IF NOT EXISTS users_by_id (
    id uuid PRIMARY KEY,
    display_name text,
    created_at timestamp
);

CREATE TABLE IF NOT EXISTS user_identities_by_provider (
    provider text,
    provider_user_id text,
    user_id uuid,
    email text,
    created_at timestamp,
    PRIMARY KEY ((provider, provider_user_id))
);

CREATE TABLE IF NOT EXISTS rooms_by_id (
    id uuid PRIMARY KEY,
    type text,
    name text,
    created_at timestamp
);

CREATE TABLE IF NOT EXISTS room_members_by_room (
    room_id uuid,
    user_id uuid,
    joined_at timestamp,
    role text,
    PRIMARY KEY (room_id, user_id)
);

CREATE TABLE IF NOT EXISTS rooms_by_user (
    user_id uuid,
    room_id uuid,
    joined_at timestamp,
    role text,
    PRIMARY KEY (user_id, room_id)
);

CREATE TABLE IF NOT EXISTS messages_by_room (
    room_id uuid,
    created_at timestamp,
    id uuid,
    sender_id uuid,
    body text,
    PRIMARY KEY (room_id, created_at, id)
) WITH CLUSTERING ORDER BY (created_at DESC, id ASC);
