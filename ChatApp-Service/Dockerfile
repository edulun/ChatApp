# syntax=docker/dockerfile:1

# --- Build stage ---
FROM eclipse-temurin:21-jdk-jammy AS build
WORKDIR /app

# Cache dependencies separately from source so a source-only change doesn't
# re-download the world.
COPY .mvn/ .mvn/
COPY mvnw pom.xml ./
RUN ./mvnw dependency:go-offline -B

COPY src/ src/
RUN ./mvnw package -B -DskipTests && \
    mv target/chatapp-service.jar target/app.jar

# --- Runtime stage ---
FROM eclipse-temurin:21-jre-jammy AS runtime
WORKDIR /app

RUN useradd --system --create-home --shell /usr/sbin/nologin chatapp
USER chatapp

COPY --from=build /app/target/app.jar app.jar

EXPOSE 8080
ENTRYPOINT ["java", "-jar", "app.jar"]
