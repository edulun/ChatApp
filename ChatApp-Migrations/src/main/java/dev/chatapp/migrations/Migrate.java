package dev.chatapp.migrations;

import com.datastax.oss.driver.api.core.CqlSession;
import com.datastax.oss.driver.api.core.cql.ResultSet;
import com.datastax.oss.driver.api.core.cql.Row;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * Applies pending Cassandra schema migrations from {@code migrations/V<n>__<description>.cql}
 * in version order, tracking what's applied in a {@code schema_migrations} table. Meant to be run
 * once per deploy (CLI/CI job), not embedded in ChatApp-Service — see DESIGN.md for why.
 */
public final class Migrate {

    private static final Pattern FILENAME = Pattern.compile("^V(\\d+)__(.+)\\.cql$");

    public static void main(String[] args) throws IOException {
        String host = env("CASSANDRA_HOST", "127.0.0.1");
        int port = Integer.parseInt(env("CASSANDRA_PORT", "9042"));
        String dc = env("CASSANDRA_DC", "datacenter1");
        String keyspace = env("CASSANDRA_KEYSPACE", "chatapp");
        Path migrationsDir = Path.of(env("MIGRATIONS_DIR", "migrations"));

        System.out.printf("Connecting to %s:%d (dc=%s, keyspace=%s)%n", host, port, dc, keyspace);

        try (CqlSession session = CqlSession.builder()
                .addContactPoint(new InetSocketAddress(host, port))
                .withLocalDatacenter(dc)
                .withKeyspace(keyspace)
                .build()) {

            session.execute("""
                CREATE TABLE IF NOT EXISTS schema_migrations (
                    version text PRIMARY KEY,
                    description text,
                    applied_at timestamp
                )
                """);

            Set<String> applied = appliedVersions(session);
            List<Path> pending = pendingMigrations(migrationsDir, applied);

            if (pending.isEmpty()) {
                System.out.println("No pending migrations.");
                return;
            }

            for (Path file : pending) {
                apply(session, file);
            }

            System.out.println("Applied " + pending.size() + " migration(s).");
        }
    }

    private static Set<String> appliedVersions(CqlSession session) {
        ResultSet rs = session.execute("SELECT version FROM schema_migrations");
        Set<String> versions = new HashSet<>();
        for (Row row : rs) {
            versions.add(row.getString("version"));
        }
        return versions;
    }

    private static List<Path> pendingMigrations(Path dir, Set<String> applied) throws IOException {
        if (!Files.isDirectory(dir)) {
            throw new IllegalStateException("Migrations directory not found: " + dir.toAbsolutePath());
        }
        try (Stream<Path> stream = Files.list(dir)) {
            return stream
                    .filter(p -> FILENAME.matcher(p.getFileName().toString()).matches())
                    .filter(p -> !applied.contains(version(p)))
                    .sorted(Comparator.comparingInt(p -> Integer.parseInt(version(p))))
                    .collect(Collectors.toList());
        }
    }

    private static String version(Path file) {
        Matcher m = FILENAME.matcher(file.getFileName().toString());
        if (!m.matches()) {
            throw new IllegalArgumentException("Bad migration filename: " + file.getFileName());
        }
        return m.group(1);
    }

    private static void apply(CqlSession session, Path file) throws IOException {
        String filename = file.getFileName().toString();
        String version = version(file);
        System.out.println("Applying " + filename + " ...");

        // Naive split on ';' — fine for DDL-only migrations (no string literals containing ';').
        // Would need a real CQL statement parser if a migration ever inserts data that does.
        String content = Files.readString(file);
        for (String statement : content.split(";")) {
            String cql = statement.strip();
            if (cql.isEmpty() || cql.startsWith("--")) {
                continue;
            }
            session.execute(cql);
        }

        session.execute(
                "INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)",
                version, filename, Instant.now());

        System.out.println("Applied " + filename);
    }

    private static String env(String name, String defaultValue) {
        String value = System.getenv(name);
        return (value == null || value.isBlank()) ? defaultValue : value;
    }

    private Migrate() {
    }
}
