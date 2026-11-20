package com.school.collab.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import org.springframework.boot.actuate.health.Status;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

class DependencyHealthConfigTest {
    @Test
    void probesCheckReadinessWithoutReturningDependencyDetails() throws Exception {
        var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        var cluster = new AtomicReference<>("{\"status\":\"yellow\"}");
        var storage = new AtomicInteger(200);
        server.createContext("/_cluster/health", exchange -> {
            byte[] body = cluster.get().getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.createContext("/minio/health/ready", exchange -> {
            exchange.sendResponseHeaders(storage.get(), -1);
            exchange.close();
        });
        server.start();
        try {
            var config = new DependencyHealthConfig();
            String endpoint = "http://127.0.0.1:" + server.getAddress().getPort();
            var es = config.searchHealthIndicator(endpoint, new ObjectMapper());
            var minio = config.minioHealthIndicator(endpoint);
            assertEquals(Status.UP, es.health().getStatus());
            assertEquals(Status.UP, minio.health().getStatus());

            cluster.set("{\"status\":\"red\",\"syntheticDetail\":\"never exposed\"}");
            storage.set(503);
            var unavailable = es.health();
            assertEquals(Status.DOWN, unavailable.getStatus());
            assertTrue(unavailable.getDetails().isEmpty());
            assertEquals(Status.DOWN, minio.health().getStatus());

            cluster.set("");
            assertEquals(Status.DOWN, es.health().getStatus());
        } finally {
            server.stop(0);
        }
    }
}
