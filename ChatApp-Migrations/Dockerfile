# syntax=docker/dockerfile:1

# --- Build stage ---
FROM eclipse-temurin:21-jdk-jammy AS build
WORKDIR /app

# Cache dependencies separately from source so a source-only change doesn't
# re-download the world. --chmod=755 on mvnw specifically: git tracks it as
# non-executable (100644) here, so relying on the build-context file's own
# bit would break on a fresh clone where git didn't preserve one.
COPY .mvn/ .mvn/
COPY --chmod=755 mvnw ./
COPY pom.xml ./
RUN ./mvnw dependency:go-offline -B

COPY src/ src/
RUN ./mvnw package -B -DskipTests && \
    mv target/chatapp-migrations.jar target/app.jar

# --- Runtime stage ---
FROM eclipse-temurin:21-jre-jammy AS runtime
WORKDIR /app

RUN useradd --system --create-home --shell /usr/sbin/nologin migrations
USER migrations

COPY --from=build /app/target/app.jar app.jar
# Migrate reads migrations/ off the filesystem relative to the working directory (not the
# classpath — see DESIGN.md §2), so it has to be copied in alongside the jar, not bundled into it.
COPY migrations/ migrations/

ENTRYPOINT ["java", "-jar", "app.jar"]
