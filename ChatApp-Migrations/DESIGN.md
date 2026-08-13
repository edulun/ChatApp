# ChatApp-Migrations — Design

See the [root system design](../DESIGN.md) for how this module fits with `ChatApp-Service`.

## Status

Working, containerized, wired into local dev. Table set below matches `ChatApp-Service/DESIGN.md`
§4 as of this writing. Verified end-to-end from a fully cold start (`docker compose down -v` then
`docker compose up -d` from `ChatApp-Service`): keyspace creates, migrations build+apply
automatically, and `ChatApp-Service` (with `schema-action: none` everywhere now) starts and
reports healthy against the resulting schema with no manual steps.

## 1. Why this is a separate module, not part of ChatApp-Service

Two Cassandra-specific reasons a Postgres/Flyway-style "run migrations on app boot" doesn't fit:

- **No transactional DDL.** Each CQL statement (`CREATE TABLE`, `ALTER TABLE`) auto-commits
  individually — there's no wrapping a migration in a rollback-able transaction. Migrations must
  be small and idempotent (`IF NOT EXISTS`), not "apply or revert as a unit."
- **Schema changes propagate asynchronously across nodes** ("schema agreement"). If every
  `ChatApp-Service` instance ran migrations on its own boot, concurrent DDL from multiple
  instances racing on deploy can produce schema disagreement across the cluster.

So this runs as a **single one-shot step, once per deploy**, before any `ChatApp-Service`
instance starts against the new schema — the same role `cassandra-init` plays for local dev in
`ChatApp-Service/docker-compose.yml` (create-keyspace once, not per instance), just for
table-level schema instead of the keyspace itself; in fact that compose file now runs this
module's own container the same way, right after `cassandra-init` (§4). `ChatApp-Service` keeps
`spring.cassandra.schema-action: none` **everywhere — local included, not just staging/prod**
(`application.yml`) specifically so it never tries to manage schema itself, anywhere — this
module is the one place schema comes from, so local dev can't quietly drift from what staging/prod
actually run.

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
- **Request timeout is explicitly raised to 30s, and connection is retried up to 5 times, 5s
  apart.** Found by testing, not theoretical: right after `cassandra-init` succeeds, the node has
  passed its Docker healthcheck (a plain connect) but isn't necessarily warmed up enough for DDL
  to complete within the driver's 2s default request timeout — the very first `CREATE TABLE
  schema_migrations` timed out under exactly that sequence. A healthcheck passing means "accepts
  connections," not "ready for every kind of query."
- Packaged as a fat jar (`maven-shade-plugin`) and a `Dockerfile` (`eclipse-temurin` JDK build
  stage → JRE runtime stage, same shape as `ChatApp-Service`'s) — `java -jar
  target/chatapp-migrations.jar` runs standalone, no Maven needed at runtime. `migrations/` is
  copied into the image alongside the jar rather than bundled inside it, since `Migrate` reads it
  off the filesystem, not the classpath.

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

**Local dev is fully automatic** — `docker compose up -d` from `ChatApp-Service` builds this
module's image and runs it (as the `migrations` service) right after `cassandra-init` creates the
keyspace, before you'd ever run `ChatApp-Service` itself:

```
cd ChatApp-Service && docker compose up -d   # cassandra + cassandra-init + migrations + redis + kafka
```

**Manually** (iterating on a new migration before rebuilding the image, or against a non-local
cluster for staging/prod):

```
cd ChatApp-Migrations
CASSANDRA_HOST=localhost CASSANDRA_PORT=9042 CASSANDRA_DC=datacenter1 CASSANDRA_KEYSPACE=chatapp \
  ./mvnw compile exec:java
```

The four env vars have the same defaults and names `ChatApp-Service/src/main/resources/
application-local.yml` uses, so against the local compose stack it runs with zero configuration.
Or as a container directly (e.g. against a different cluster, or to test the built image without
Maven): `docker build -t chatapp-migrations . && docker run --rm -e CASSANDRA_HOST=<host>
chatapp-migrations`.

## 5. Open questions

- Keyspace creation/replication factor for a real (non-single-node) deployment is still
  unresolved — see `ChatApp-Service/DESIGN.md` §10 — and isn't handled by this module (§1 scope
  boundary above).
- No CI pipeline actually runs this against staging/prod yet — the `Dockerfile`/image exists and
  is proven locally, but "build this image and run it before the next `ChatApp-Service` deploy"
  isn't wired into any deploy process, because none exists yet for either module.
