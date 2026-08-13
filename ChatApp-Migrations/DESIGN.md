# ChatApp-Migrations — Design

See the [root system design](../DESIGN.md) for how this module fits with `ChatApp-Service`.

## Status

Working, minimal, tested locally against the same Cassandra `ChatApp-Service/docker-compose.yml`
brings up. Table set below matches `ChatApp-Service/DESIGN.md` §4 as of this writing.

## 1. Why this is a separate module, not part of ChatApp-Service

Two Cassandra-specific reasons a Postgres/Flyway-style "run migrations on app boot" doesn't fit:

- **No transactional DDL.** Each CQL statement (`CREATE TABLE`, `ALTER TABLE`) auto-commits
  individually — there's no wrapping a migration in a rollback-able transaction. Migrations must
  be small and idempotent (`IF NOT EXISTS`), not "apply or revert as a unit."
- **Schema changes propagate asynchronously across nodes** ("schema agreement"). If every
  `ChatApp-Service` instance ran migrations on its own boot, concurrent DDL from multiple
  instances racing on deploy can produce schema disagreement across the cluster.

So this runs as a **single one-shot step, once per deploy**, before any `ChatApp-Service`
instance starts against the new schema — conceptually the same role `cassandra-init` plays for
local dev in `ChatApp-Service/docker-compose.yml` (create-keyspace once, not per instance), just
for table-level schema instead of the keyspace itself. `ChatApp-Service` keeps
`spring.cassandra.schema-action: none` in staging/prod (`application-staging.yml`,
`application-prod.yml`) specifically so it never tries to manage schema itself — this module is
the answer to that gap.

**Scope boundary**: this module owns table DDL within an *existing* keyspace. Keyspace creation
and replication factor are infra/ops decisions (local dev's `cassandra-init` handles it for now;
staging/prod isn't decided — see `ChatApp-Service/DESIGN.md` §10) and deliberately out of scope
here, to keep "did the schema change" separate from "does the cluster/keyspace exist."

## 2. How it works

- `migrations/V<n>__<description>.cql` — versioned, ordered CQL files. `V1__initial_schema.cql`
  is the current set.
- A `schema_migrations` table (`version` `text` PRIMARY KEY, `description`, `applied_at`) tracks
  what's been applied, created on first run if missing.
- `Migrate` (the only class) connects, diffs pending-vs-applied by filename version number, and
  executes each pending file's statements in order, recording it as applied immediately after.
  Statement splitting is a naive `split(";")` — fine for DDL-only migrations; would need a real
  CQL parser if a migration ever needs to insert data containing a literal `;`.
- No dependency on `ChatApp-Service` or Spring — just `java-driver-core`, the same version
  (`4.18.1`) `ChatApp-Service` already resolves transitively, kept in lockstep deliberately so
  both sides agree on driver behavior.

## 3. Conventions

- **Never edit an already-applied migration file.** Add a new `V<n+1>__...cql` instead — same
  reasoning as `ChatApp-Contracts/DESIGN.md` §5's additive-only policy: a file that already ran
  against some environment is effectively immutable.
- **Every statement must be safely re-runnable** (`IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`).
  Since there's no DDL transaction, a migration that fails partway through must not break on
  retry.
- **Additive-only, same as the contracts policy**: don't drop or retype a column a currently
  deployed `ChatApp-Service` version still reads. Add new columns/tables instead.

## 4. Running it

```
cd ChatApp-Migrations
CASSANDRA_HOST=localhost CASSANDRA_PORT=9042 CASSANDRA_DC=datacenter1 CASSANDRA_KEYSPACE=chatapp \
  ./mvnw compile exec:java
```

All four env vars have the same defaults and names `ChatApp-Service/src/main/resources/
application-local.yml` uses, so against the standard local `docker compose up -d` stack (from
`ChatApp-Service`), it runs with zero configuration:

```
cd ChatApp-Service && docker compose up -d   # cassandra + cassandra-init + redis + kafka
cd ../ChatApp-Migrations && ./mvnw compile exec:java
```

## 5. Open questions

- No containerized packaging yet (`ChatApp-Service` has a `Dockerfile`; this doesn't). Add one
  once actual deployment — not just local dev — is being designed, so this can run as a CI/CD job
  step rather than only from a checked-out working copy.
- Whether local dev should eventually run *these* migrations too (instead of relying on Spring
  Data's `schema-action: create_if_not_exists` in `application-local.yml`), so local, staging, and
  prod schema all come from the same source instead of two different mechanisms.
- Keyspace creation/replication factor for a real (non-single-node) deployment is still
  unresolved — see `ChatApp-Service/DESIGN.md` §10 — and isn't handled by this module (§1 scope
  boundary above).
