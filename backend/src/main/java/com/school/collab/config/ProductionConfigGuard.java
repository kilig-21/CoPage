package com.school.collab.config;

import org.springframework.beans.factory.InitializingBean;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.nio.charset.StandardCharsets;

/** Prevent development defaults from being used when the production profile is active. */
@Component
@Profile("prod")
public class ProductionConfigGuard implements InitializingBean {

    private final String frontendOrigin;
    private final String minioPublicEndpoint;
    private final String jwtSecret;
    private final String mysqlPassword;
    private final String rabbitPassword;
    private final String minioAccessKey;
    private final String minioSecretKey;

    public ProductionConfigGuard(
            @Value("${collab.frontend-origin}") String frontendOrigin,
            @Value("${collab.minio.public-endpoint}") String minioPublicEndpoint,
            @Value("${collab.jwt.secret}") String jwtSecret,
            @Value("${spring.datasource.password}") String mysqlPassword,
            @Value("${spring.rabbitmq.password}") String rabbitPassword,
            @Value("${collab.minio.access-key}") String minioAccessKey,
            @Value("${collab.minio.secret-key}") String minioSecretKey
    ) {
        this.frontendOrigin = frontendOrigin;
        this.minioPublicEndpoint = minioPublicEndpoint;
        this.jwtSecret = jwtSecret;
        this.mysqlPassword = mysqlPassword;
        this.rabbitPassword = rabbitPassword;
        this.minioAccessKey = minioAccessKey;
        this.minioSecretKey = minioSecretKey;
    }

    @Override
    public void afterPropertiesSet() {
        requireHttpsUrl(frontendOrigin, "FRONTEND_ORIGIN", true);
        requireHttpsUrl(minioPublicEndpoint, "MINIO_PUBLIC_ENDPOINT", false);
        if (jwtSecret.getBytes(StandardCharsets.UTF_8).length < 32
                || "change-this-local-development-secret-key-please".equals(jwtSecret)) {
            throw new IllegalStateException("生产环境必须配置至少 32 字节的独立 JWT_SECRET");
        }
        requireNonDefault(mysqlPassword, "123456", "MYSQL_PASSWORD");
        requireNonDefault(rabbitPassword, "123456", "RABBITMQ_PASSWORD");
        requireNonDefault(minioAccessKey, "minioadmin", "MINIO_ACCESS_KEY");
        requireNonDefault(minioSecretKey, "minioadmin", "MINIO_SECRET_KEY");
    }

    private static void requireHttpsUrl(String value, String name, boolean originOnly) {
        URI uri;
        try {
            uri = URI.create(value);
        } catch (IllegalArgumentException exception) {
            throw new IllegalStateException(name + " 必须是有效的 HTTPS 地址", exception);
        }
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null
                || uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null
                || (originOnly && !(uri.getRawPath() == null || uri.getRawPath().isEmpty()))) {
            throw new IllegalStateException(name + " 必须是 HTTPS 地址，FRONTEND_ORIGIN 不得含路径");
        }
    }

    private static void requireNonDefault(String value, String defaultValue, String name) {
        if (value.isBlank() || defaultValue.equals(value)) {
            throw new IllegalStateException("生产环境必须替换演示用的 " + name);
        }
    }
}
