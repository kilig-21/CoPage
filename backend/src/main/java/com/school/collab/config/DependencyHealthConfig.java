package com.school.collab.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.HealthIndicator;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Set;

@Configuration(proxyBeanMethods = false)
public class DependencyHealthConfig {
    private static final Duration PROBE_TIMEOUT = Duration.ofSeconds(2);
    private static final Set<String> SEARCH_READY = Set.of("green", "yellow");
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(PROBE_TIMEOUT).build();

    @Bean
    HealthIndicator searchHealthIndicator(@Value("${spring.elasticsearch.uris}") String endpoint, ObjectMapper mapper) {
        var request = request(endpoint, "/_cluster/health?local=true&filter_path=status");
        return () -> {
            try {
                var response = http.send(request, HttpResponse.BodyHandlers.ofString());
                if (response.statusCode() != 200) return Health.down().build();
                var body = mapper.readTree(response.body());
                return readiness(body != null && SEARCH_READY.contains(body.path("status").asText()));
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return Health.down().build();
            } catch (IOException failure) {
                return Health.down().build();
            }
        };
    }

    @Bean
    HealthIndicator minioHealthIndicator(@Value("${collab.minio.endpoint}") String endpoint) {
        var request = request(endpoint, "/minio/health/ready");
        return () -> {
            try {
                return readiness(http.send(request, HttpResponse.BodyHandlers.discarding()).statusCode() == 200);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return Health.down().build();
            } catch (IOException failure) {
                return Health.down().build();
            }
        };
    }

    private static HttpRequest request(String endpoint, String path) {
        return HttpRequest.newBuilder(URI.create(endpoint.replaceAll("/+$", "") + path)).timeout(PROBE_TIMEOUT).GET().build();
    }

    private static Health readiness(boolean ready) {
        return ready ? Health.up().build() : Health.down().build();
    }
}
