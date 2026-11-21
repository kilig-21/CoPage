package com.school.collab.config;

import java.util.Map;
import java.util.UUID;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import org.springframework.boot.Banner;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.WebApplicationType;
import org.springframework.context.annotation.Configuration;
import org.springframework.mock.env.MockEnvironment;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ProductionConfigGuardTest {
    private static final String SECRET = UUID.randomUUID().toString();
    private static final String LEGACY_JWT = "change-this-local-development-secret-key-please";

    private static MockEnvironment production() {
        return new MockEnvironment()
                .withProperty("collab.config-mode", "private-compose")
                .withProperty("collab.frontend-origin", "https://frontend.example.invalid")
                .withProperty("collab.minio.public-endpoint", "https://files.example.invalid/storage")
                .withProperty("collab.jwt.secret", SECRET)
                .withProperty("spring.datasource.url", "jdbc:mysql://mysql:3306/copage?sslMode=DISABLED")
                .withProperty("spring.datasource.username", "copage")
                .withProperty("spring.datasource.password", SECRET)
                .withProperty("spring.data.redis.host", "redis")
                .withProperty("spring.data.redis.password", SECRET)
                .withProperty("spring.rabbitmq.host", "rabbitmq")
                .withProperty("spring.rabbitmq.username", "copage")
                .withProperty("spring.rabbitmq.password", SECRET)
                .withProperty("spring.elasticsearch.uris", "http://elasticsearch:9200,https://search.example.invalid")
                .withProperty("collab.minio.endpoint", "http://minio:9000")
                .withProperty("collab.minio.access-key", "copage-fixture")
                .withProperty("collab.minio.secret-key", SECRET);
    }

    @Test
    void acceptsOnlyExplicitComposeTransportForInternalHosts() {
        assertDoesNotThrow(() -> ProductionConfigGuard.validate(production()));
        var env = production().withProperty("collab.config-mode", "strict")
                .withProperty("spring.data.redis.ssl.enabled", "true")
                .withProperty("spring.rabbitmq.ssl.enabled", "true")
                .withProperty("spring.datasource.url", "jdbc:mysql://db.example.invalid/copage?sslMode=VERIFY_IDENTITY")
                .withProperty("spring.elasticsearch.uris", "https://search.example.invalid")
                .withProperty("collab.minio.endpoint", "https://storage.example.invalid");
        assertDoesNotThrow(() -> ProductionConfigGuard.validate(env));
    }

    @Test
    void acceptsExplicitLocalWithASecretAndLocalDependencies() {
        var env = production().withProperty("collab.config-mode", "local")
                .withProperty("collab.frontend-origin", "http://localhost:5173")
                .withProperty("collab.minio.public-endpoint", "http://[::1]:9000")
                .withProperty("spring.elasticsearch.uris", "http://elasticsearch:9200")
                .withProperty("spring.data.redis.password", "");
        assertDoesNotThrow(() -> ProductionConfigGuard.validate(env));
        assertRejected(env.withProperty("spring.datasource.url", "jdbc:mysql://db.example.invalid/copage"), "MYSQL_URL");
        env.setActiveProfiles("prod");
        assertRejected(env, "COPAGE_CONFIG_MODE");
    }

    @ParameterizedTest
    @MethodSource("invalidSettings")
    void rejectsInvalidSettingsWithoutEchoingTheirValues(String property, String value, String envName) {
        var failure = assertRejected(production().withProperty(property, value), envName);
        if (!value.isBlank()) {
            assertFalse(failure.getMessage().contains(value));
        }
        assertNull(failure.getCause());
    }

    static Stream<Arguments> invalidSettings() {
        return Stream.of(
                Arguments.of("collab.config-mode", "off", "COPAGE_CONFIG_MODE"),
                Arguments.of("collab.jwt.secret", "", "JWT_SECRET"),
                Arguments.of("collab.jwt.secret", LEGACY_JWT, "JWT_SECRET"),
                Arguments.of("collab.jwt.secret", "12345678901234567890123456789012", "JWT_SECRET"),
                Arguments.of("spring.datasource.password", "ChangeMe202610", "MYSQL_PASSWORD"),
                Arguments.of("spring.data.redis.password", "", "REDIS_PASSWORD"),
                Arguments.of("spring.rabbitmq.password", "short-demo", "RABBITMQ_PASSWORD"),
                Arguments.of("collab.minio.access-key", "minioadmin", "MINIO_ACCESS_KEY"),
                Arguments.of("collab.minio.secret-key", "password123456", "MINIO_SECRET_KEY"),
                Arguments.of("spring.datasource.username", "root", "MYSQL_USER"),
                Arguments.of("spring.rabbitmq.username", "guest", "RABBITMQ_USER"),
                Arguments.of("collab.frontend-origin", "http://frontend.example.invalid", "FRONTEND_ORIGIN"),
                Arguments.of("collab.frontend-origin", "https://frontend.example.invalid/", "FRONTEND_ORIGIN"),
                Arguments.of("collab.minio.public-endpoint", "https://person:fixture-secret@bad host", "MINIO_PUBLIC_ENDPOINT"),
                Arguments.of("spring.datasource.url", "jdbc:postgresql://mysql:3306/copage", "MYSQL_URL"),
                Arguments.of("spring.datasource.url", "jdbc:mysql://db.example.invalid/copage?useSSL=false", "MYSQL_URL"),
                Arguments.of("spring.datasource.url", "jdbc:mysql://mysql/copage?user=fixture&password=fixture-secret", "MYSQL_URL"),
                Arguments.of("spring.datasource.url", "jdbc:mysql://db.example.invalid/copage?sslMode=VERIFY_IDENTITY&SSLMode=DISABLED", "MYSQL_URL"),
                Arguments.of("spring.elasticsearch.uris", "http://elasticsearch:9200,ftp://bad.example.invalid", "ELASTICSEARCH_URIS"),
                Arguments.of("spring.elasticsearch.uris", "http://elasticsearch.example.invalid:9200", "ELASTICSEARCH_URIS"),
                Arguments.of("collab.minio.endpoint", "//minio:9000", "MINIO_ENDPOINT"),
                Arguments.of("collab.minio.endpoint", "http://external-minio.example.invalid:9000", "MINIO_ENDPOINT"),
                Arguments.of("spring.data.redis.host", "redis.example.invalid", "REDIS_HOST"),
                Arguments.of("spring.rabbitmq.host", "rabbitmq.example.invalid", "RABBITMQ_HOST"),
                Arguments.of("spring.data.redis.url", "redis://person:fixture-secret@redis:6379", "SPRING_DATA_REDIS_URL"),
                Arguments.of("spring.rabbitmq.addresses", "amqp://person:fixture-secret@rabbitmq:5672", "SPRING_RABBITMQ_ADDRESSES"),
                Arguments.of("spring.flyway.url", "jdbc:mysql://dev-fixture.invalid/copage", "SPRING_FLYWAY_URL"),
                Arguments.of("spring.datasource.hikari.jdbc-url", "jdbc:mysql://dev-fixture.invalid/copage", "SPRING_DATASOURCE_HIKARI_JDBC_URL"));
    }

    @Test
    void springBootRejectsDefaultProfileAndMissingSecretDuringInitialization() {
        var app = new SpringApplication(EmptyConfiguration.class);
        app.setWebApplicationType(WebApplicationType.NONE);
        app.setBannerMode(Banner.Mode.OFF);
        app.setLogStartupInfo(false);
        app.setDefaultProperties(Map.of("spring.main.register-shutdown-hook", "false"));
        var failure = assertThrows(IllegalStateException.class, () -> app.run(
                "--spring.profiles.active=qa", "--collab.jwt.secret="));
        assertTrue(failure.getMessage().contains("JWT_SECRET"));
    }

    private static IllegalStateException assertRejected(MockEnvironment env, String name) {
        var failure = assertThrows(IllegalStateException.class, () -> ProductionConfigGuard.validate(env));
        assertTrue(failure.getMessage().contains(name), failure.getMessage());
        return failure;
    }

    @Configuration(proxyBeanMethods = false)
    static class EmptyConfiguration {
    }
}
