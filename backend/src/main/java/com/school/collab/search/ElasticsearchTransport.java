package com.school.collab.search;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

@Component
final class ElasticsearchTransport {
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();
    private final ObjectMapper mapper;
    private final String endpoint;

    ElasticsearchTransport(ObjectMapper mapper, @Value("${spring.elasticsearch.uris}") String endpoint) {
        this.mapper = mapper;
        this.endpoint = endpoint.replaceAll("/+$", "");
    }

    Response send(String method, String path, JsonNode body) {
        try {
            var request = HttpRequest.newBuilder(URI.create(endpoint + path)).timeout(Duration.ofSeconds(8));
            if (body == null) {
                request.method(method, HttpRequest.BodyPublishers.noBody());
            } else {
                request.header("Content-Type", "application/json")
                        .method(method, HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(body)));
            }
            HttpResponse<String> response = http.send(request.build(), HttpResponse.BodyHandlers.ofString());
            JsonNode parsed = response.body().isBlank() ? mapper.nullNode() : mapper.readTree(response.body());
            return new Response(response.statusCode(), parsed);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Elasticsearch 请求失败", interrupted);
        } catch (IOException | RuntimeException failure) {
            throw new IllegalStateException("Elasticsearch 请求失败", failure);
        }
    }

    record Response(int status, JsonNode body) { }
}
