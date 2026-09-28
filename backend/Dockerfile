FROM maven:3.9.16-eclipse-temurin-21-noble AS build

WORKDIR /workspace
COPY pom.xml ./
RUN mvn -B -ntp dependency:go-offline
COPY src ./src
RUN mvn -B -ntp -DskipTests package

FROM eclipse-temurin:21-jre-noble

RUN groupadd --system app && useradd --system --gid app app
WORKDIR /app
COPY --from=build --chown=app:app /workspace/target/collab-docs-backend-0.0.1-SNAPSHOT-exec.jar app.jar
USER app

EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
