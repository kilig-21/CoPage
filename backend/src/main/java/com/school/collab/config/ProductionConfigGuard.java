package com.school.collab.config;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.springframework.boot.context.properties.bind.Bindable;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.context.ApplicationContextInitializer;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.core.env.ConfigurableEnvironment;

/** Checks effective settings before Spring opens connections or starts migrations. */
public final class ProductionConfigGuard implements ApplicationContextInitializer<ConfigurableApplicationContext> {
    private static final Set<String> LOOPBACK = Set.of("localhost", "127.0.0.1", "[::1]");
    private static final Set<String> WEAK = Set.of(
            "password", "changeme", "changeit", "admin", "adminadmin", "root", "secret", "minioadmin",
            "guest", "qwerty", "123456", "12345678", "123456789", "password123", "password123456",
            "change-this-local-development-secret-key-please");

    @Override
    public void initialize(ConfigurableApplicationContext context) {
        validate(context.getEnvironment());
    }

    static void validate(ConfigurableEnvironment env) {
        var mode = read(env, "collab.config-mode", "COPAGE_CONFIG_MODE");
        if (!Set.of("strict", "private-compose", "local").contains(mode)) {
            throw invalid("COPAGE_CONFIG_MODE", "须为 strict、private-compose 或 local");
        }
        boolean local = mode.equals("local");
        boolean privateCompose = mode.equals("private-compose");
        if (local && env.matchesProfiles("prod")) {
            throw invalid("COPAGE_CONFIG_MODE", "prod profile 须使用 strict 或 private-compose");
        }

        requireSecret(env, "collab.jwt.secret", "JWT_SECRET", 32);
        var frontend = endpoint(read(env, "collab.frontend-origin", "FRONTEND_ORIGIN"), "FRONTEND_ORIGIN");
        if (!frontend.getRawPath().isEmpty()) {
            throw invalid("FRONTEND_ORIGIN", "须为不含路径的浏览器 origin");
        }
        var publicImages = endpoint(read(env, "collab.minio.public-endpoint", "MINIO_PUBLIC_ENDPOINT"), "MINIO_PUBLIC_ENDPOINT");
        if (local) {
            requireLocalHost(frontend.getHost(), "FRONTEND_ORIGIN", "");
            requireLocalHost(publicImages.getHost(), "MINIO_PUBLIC_ENDPOINT", "");
        } else {
            requireHttps(frontend, "FRONTEND_ORIGIN");
            requireHttps(publicImages, "MINIO_PUBLIC_ENDPOINT");
            requireSecret(env, "spring.datasource.password", "MYSQL_PASSWORD", 12);
            requireSecret(env, "spring.data.redis.password", "REDIS_PASSWORD", 12);
            requireSecret(env, "spring.rabbitmq.password", "RABBITMQ_PASSWORD", 12);
            requireSecret(env, "collab.minio.access-key", "MINIO_ACCESS_KEY", 8);
            requireSecret(env, "collab.minio.secret-key", "MINIO_SECRET_KEY", 12);
            var mysqlUser = read(env, "spring.datasource.username", "MYSQL_USER");
            if (mysqlUser.isBlank() || mysqlUser.equalsIgnoreCase("root")) {
                throw invalid("MYSQL_USER", "须配置独立的应用账号");
            }
            var rabbitUser = read(env, "spring.rabbitmq.username", "RABBITMQ_USER");
            if (rabbitUser.isBlank() || rabbitUser.equalsIgnoreCase("guest")) {
                throw invalid("RABBITMQ_USER", "须配置独立的应用账号");
            }
        }

        // These alternative settings override the host or credential fields this application validates.
        rejectOverride(env, "spring.data.redis.url", "SPRING_DATA_REDIS_URL");
        rejectOverride(env, "spring.data.redis.sentinel.master", "SPRING_DATA_REDIS_SENTINEL_MASTER");
        rejectListOverride(env, "spring.data.redis.cluster.nodes", "SPRING_DATA_REDIS_CLUSTER_NODES");
        rejectOverride(env, "spring.rabbitmq.addresses", "SPRING_RABBITMQ_ADDRESSES");
        rejectOverride(env, "spring.flyway.url", "SPRING_FLYWAY_URL");
        rejectOverride(env, "spring.datasource.hikari.jdbc-url", "SPRING_DATASOURCE_HIKARI_JDBC_URL");
        requireServiceHost(env, "spring.data.redis.host", "REDIS_HOST", "redis", local, privateCompose);
        requireServiceHost(env, "spring.rabbitmq.host", "RABBITMQ_HOST", "rabbitmq", local, privateCompose);

        requireMysql(read(env, "spring.datasource.url", "MYSQL_URL"), local, privateCompose);
        var searchEndpoints = list(env, "spring.elasticsearch.uris", "ELASTICSEARCH_URIS");
        if (searchEndpoints.isEmpty()) {
            throw invalid("ELASTICSEARCH_URIS", "须配置至少一个 Elasticsearch 地址");
        }
        for (String address : searchEndpoints) {
            requireInternalEndpoint(address, "ELASTICSEARCH_URIS", "elasticsearch", local, privateCompose);
        }
        requireInternalEndpoint(read(env, "collab.minio.endpoint", "MINIO_ENDPOINT"),
                "MINIO_ENDPOINT", "minio", local, privateCompose);
    }

    private static void requireSecret(ConfigurableEnvironment env, String property, String name, int minBytes) {
        var value = read(env, property, name);
        var normalized = value.strip().toLowerCase(Locale.ROOT);
        if (!value.equals(value.strip()) || value.isBlank() || value.getBytes(StandardCharsets.UTF_8).length < minBytes
                || WEAK.contains(normalized) || normalized.matches("(?:password|changeme|changeit|letmein|qwerty|admin|secret)[0-9!@#$._-]*")
                || normalized.matches("[0-9]+") || normalized.codePoints().distinct().count() < 4) {
            throw invalid(name, "须配置独立的强凭据，至少 " + minBytes + " 字节");
        }
    }

    private static void requireMysql(String address, boolean local, boolean privateCompose) {
        if (!address.startsWith("jdbc:")) {
            throw invalid("MYSQL_URL", "须使用 jdbc:mysql:// 地址");
        }
        var uri = parse(address.substring("jdbc:".length()), "MYSQL_URL");
        if (!"mysql".equals(uri.getScheme()) || uri.getRawPath() == null || uri.getRawPath().length() < 2) {
            throw invalid("MYSQL_URL", "须使用 jdbc:mysql:// 地址并指定数据库");
        }
        var options = mysqlOptions(uri);
        if (local) {
            requireLocalHost(uri.getHost(), "MYSQL_URL", "mysql");
        } else if (!privateCompose || !"mysql".equals(uri.getHost())) {
            if (!"VERIFY_IDENTITY".equals(options.get("sslmode"))) {
                throw invalid("MYSQL_URL", "须配置 sslMode=VERIFY_IDENTITY");
            }
        }
    }

    private static Map<String, String> mysqlOptions(URI uri) {
        var options = new HashMap<String, String>();
        if (uri.getRawQuery() != null) {
            for (String parameter : uri.getRawQuery().split("&", -1)) {
                var pair = parameter.split("=", 2);
                var name = URLDecoder.decode(pair[0], StandardCharsets.UTF_8).toLowerCase(Locale.ROOT);
                if (pair.length != 2 || name.isBlank() || Set.of("user", "password", "propertiestransform", "useconfigs").contains(name)
                        || options.putIfAbsent(name, URLDecoder.decode(pair[1], StandardCharsets.UTF_8)) != null) {
                    throw invalid("MYSQL_URL", "连接参数须唯一，账号和密码使用独立变量");
                }
            }
        }
        return options;
    }

    private static void requireInternalEndpoint(String address, String name, String composeHost,
                                                boolean local, boolean privateCompose) {
        var uri = endpoint(address, name);
        if (local) {
            requireLocalHost(uri.getHost(), name, composeHost);
        } else if (!privateCompose || !composeHost.equals(uri.getHost())) {
            requireHttps(uri, name);
        }
    }

    private static void requireServiceHost(ConfigurableEnvironment env, String property, String name,
                                           String composeHost, boolean local, boolean privateCompose) {
        var host = read(env, property, name);
        if (host.isBlank()) {
            throw invalid(name, "须配置服务主机");
        }
        if (local) {
            requireLocalHost(host, name, composeHost);
        } else if (!privateCompose || !composeHost.equals(host)) {
            var service = property.substring(0, property.lastIndexOf('.'));
            if (!"true".equalsIgnoreCase(read(env, service + ".ssl.enabled", name))) {
                throw invalid(name, "须启用服务 TLS");
            }
        }
    }

    private static URI endpoint(String value, String name) {
        var uri = parse(value, name);
        if (!("http".equals(uri.getScheme()) || "https".equals(uri.getScheme())) || uri.getRawQuery() != null) {
            throw invalid(name, "须为有效的 HTTP(S) 地址");
        }
        return uri;
    }

    private static URI parse(String value, String name) {
        final URI uri;
        try {
            uri = URI.create(value);
        } catch (IllegalArgumentException ignored) {
            throw invalid(name, "地址格式无效");
        }
        if (uri.getHost() == null || uri.getRawUserInfo() != null || uri.getRawFragment() != null
                || uri.getPort() == 0 || uri.getPort() > 65535) {
            throw invalid(name, "地址须包含有效主机，且不含用户信息或片段");
        }
        return uri;
    }

    private static void requireHttps(URI uri, String name) {
        if (!"https".equals(uri.getScheme())) {
            throw invalid(name, "须使用 HTTPS");
        }
    }

    private static void requireLocalHost(String host, String name, String composeHost) {
        if (!LOOPBACK.contains(host.toLowerCase(Locale.ROOT)) && !composeHost.equals(host)) {
            throw invalid(name, "local 模式仅允许回环或本地 Compose 服务");
        }
    }

    private static void rejectOverride(ConfigurableEnvironment env, String property, String name) {
        if (!read(env, property, name).isBlank()) {
            throw invalid(name, "请使用已校验的主机和凭据配置");
        }
    }

    private static void rejectListOverride(ConfigurableEnvironment env, String property, String name) {
        if (!list(env, property, name).isEmpty()) {
            throw invalid(name, "请使用已校验的主机和凭据配置");
        }
    }

    private static List<String> list(ConfigurableEnvironment env, String property, String name) {
        try {
            return Binder.get(env).bind(property, Bindable.listOf(String.class)).orElseGet(List::of);
        } catch (RuntimeException ignored) {
            throw invalid(name, "配置格式无效");
        }
    }

    private static String read(ConfigurableEnvironment env, String property, String name) {
        try {
            return env.getProperty(property, "");
        } catch (IllegalArgumentException ignored) {
            throw invalid(name, "缺少配置");
        }
    }

    private static IllegalStateException invalid(String name, String message) {
        return new IllegalStateException("CoPage 启动配置 " + name + " " + message);
    }
}
