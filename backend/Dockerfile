ARG MAVEN_IMAGE=maven:3.9.16-eclipse-temurin-21-noble
ARG JRE_IMAGE=eclipse-temurin:21-jre-noble
FROM ${MAVEN_IMAGE} AS build

WORKDIR /workspace
COPY pom.xml ./
RUN mvn -B -ntp dependency:go-offline
COPY src ./src
RUN mvn -B -ntp -DskipTests package

FROM ${JRE_IMAGE}

RUN groupadd --system app && useradd --system --gid app app
WORKDIR /app
COPY --from=build --chown=app:app /workspace/target/collab-docs-backend-0.0.1-SNAPSHOT-exec.jar app.jar
USER app

EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
