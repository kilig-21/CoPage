package com.school.collab.observability;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.ObjectReader;
import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

@RestController
public class FrontendErrorController {
    public static final String PATH = "/api/telemetry/frontend-errors";
    private static final Logger log = LoggerFactory.getLogger(FrontendErrorController.class);
    private static final int MAX_BODY_BYTES = 512;
    private static final List<String> QUOTA_KEY = List.of("collab:telemetry:frontend-errors");
    private static final Set<String> SOURCES = Set.of("render", "window", "rejection");
    private static final Set<String> ROUTES = Set.of("/login", "/home", "/account", "/docs", "/docs/:id",
            "/groups", "/projects", "/templates", "/search", "/trash", "other");
    private static final Set<String> KINDS = Set.of("Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError",
            "TypeError", "URIError", "AggregateError", "unknown");
    private static final Set<String> ENVIRONMENTS = Set.of("production", "staging", "development");
    private static final Pattern RELEASE = Pattern.compile("(?:[0-9a-f]{40}|[0-9a-f]{64}|unknown)");
    private static final DefaultRedisScript<Long> RESERVE = new DefaultRedisScript<>("""
            local count = tonumber(redis.call('get', KEYS[1]) or '0')
            if count >= tonumber(ARGV[1]) then return 0 end
            if redis.call('incr', KEYS[1]) == 1 then redis.call('expire', KEYS[1], 60) end
            return 1
            """, Long.class);

    private final ObjectReader reader;
    private final StringRedisTemplate redis;
    private final String allowedOrigin;
    private final boolean enabled;
    private final String limit;

    public FrontendErrorController(ObjectMapper mapper, StringRedisTemplate redis,
                                   @Value("${collab.frontend-origin}") String allowedOrigin,
                                   @Value("${collab.frontend-error-reporting.enabled}") boolean enabled,
                                   @Value("${collab.frontend-error-reporting.limit-per-minute}") int limit) {
        if (limit <= 0) throw new IllegalArgumentException("前端错误上报限额必须为正整数");
        this.reader = mapper.readerFor(JsonNode.class).with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
                .with(JsonParser.Feature.STRICT_DUPLICATE_DETECTION);
        this.redis = redis;
        this.allowedOrigin = allowedOrigin;
        this.enabled = enabled;
        this.limit = Integer.toString(limit);
    }

    @PostMapping(path = PATH, consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Void> report(HttpServletRequest request) {
        if (!enabled) return ResponseEntity.notFound().build();
        if (!allowedOrigin.equals(request.getHeader("Origin"))) return ResponseEntity.status(403).build();
        if (request.getContentLengthLong() > MAX_BODY_BYTES) return ResponseEntity.status(413).build();

        JsonNode event;
        try {
            byte[] body = request.getInputStream().readNBytes(MAX_BODY_BYTES + 1);
            if (body.length > MAX_BODY_BYTES) return ResponseEntity.status(413).build();
            event = reader.readValue(body);
        } catch (IOException failure) {
            return ResponseEntity.badRequest().build();
        }
        if (!valid(event)) return ResponseEntity.badRequest().build();

        try {
            if (!Long.valueOf(1).equals(redis.execute(RESERVE, QUOTA_KEY, limit))) {
                return ResponseEntity.status(429).build();
            }
        } catch (RuntimeException failure) {
            return ResponseEntity.status(503).build();
        }
        log.warn("frontend_error environment={} release={} route={} source={} kind={}",
                event.path("environment").textValue(), event.path("release").textValue(),
                event.path("route").textValue(), event.path("source").textValue(), event.path("kind").textValue());
        return ResponseEntity.noContent().build();
    }

    private static boolean valid(JsonNode event) {
        if (event == null || !event.isObject() || event.size() != 5) return false;
        return SOURCES.contains(event.path("source").asText(""))
                && ROUTES.contains(event.path("route").asText(""))
                && KINDS.contains(event.path("kind").asText(""))
                && ENVIRONMENTS.contains(event.path("environment").asText(""))
                && event.path("release").isTextual()
                && RELEASE.matcher(event.path("release").textValue()).matches();
    }
}
