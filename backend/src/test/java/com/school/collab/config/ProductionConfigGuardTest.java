package com.school.collab.config;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;

class ProductionConfigGuardTest {

    private static ProductionConfigGuard guard(String frontend, String minioPublic, String jwt,
                                               String mysqlPassword, String rabbitPassword,
                                               String minioAccessKey, String minioSecretKey) {
        return new ProductionConfigGuard(frontend, minioPublic, jwt, mysqlPassword,
                rabbitPassword, minioAccessKey, minioSecretKey);
    }

    @Test
    void acceptsDistinctProductionValues() {
        assertDoesNotThrow(() -> guard("https://preview.example.com", "https://files.example.com/storage",
                "a-long-unique-production-secret-with-32-bytes", "mysql-private-pass",
                "rabbit-private-pass", "minio-private-user", "minio-private-pass").afterPropertiesSet());
    }

    @Test
    void rejectsNonHttpsAndNonOriginUrls() {
        assertThrows(IllegalStateException.class, () -> guard("http://preview.example.com",
                "https://files.example.com", "a-long-unique-production-secret-with-32-bytes",
                "mysql-private-pass", "rabbit-private-pass", "minio-private-user",
                "minio-private-pass").afterPropertiesSet());
        assertThrows(IllegalStateException.class, () -> guard("https://preview.example.com/path",
                "https://files.example.com", "a-long-unique-production-secret-with-32-bytes",
                "mysql-private-pass", "rabbit-private-pass", "minio-private-user",
                "minio-private-pass").afterPropertiesSet());
        assertThrows(IllegalStateException.class, () -> guard("https://preview.example.com",
                "http://files.example.com", "a-long-unique-production-secret-with-32-bytes",
                "mysql-private-pass", "rabbit-private-pass", "minio-private-user",
                "minio-private-pass").afterPropertiesSet());
    }

    @Test
    void rejectsDemoSecrets() {
        assertThrows(IllegalStateException.class, () -> guard("https://preview.example.com",
                "https://files.example.com", "change-this-local-development-secret-key-please",
                "mysql-private-pass", "rabbit-private-pass", "minio-private-user",
                "minio-private-pass").afterPropertiesSet());
        assertThrows(IllegalStateException.class, () -> guard("https://preview.example.com",
                "https://files.example.com", "a-long-unique-production-secret-with-32-bytes",
                "123456", "rabbit-private-pass", "minio-private-user",
                "minio-private-pass").afterPropertiesSet());
        assertThrows(IllegalStateException.class, () -> guard("https://preview.example.com",
                "https://files.example.com", "a-long-unique-production-secret-with-32-bytes",
                "mysql-private-pass", "rabbit-private-pass", "minioadmin",
                "minio-private-pass").afterPropertiesSet());
    }
}
