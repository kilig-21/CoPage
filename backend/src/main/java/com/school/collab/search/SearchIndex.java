package com.school.collab.search;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.school.collab.document.DocumentRepository;
import com.school.collab.document.DocumentRepository.DocumentRow;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;

/** Elasticsearch 只保存可重建的检索副本；授权和当前状态以 MySQL 为准。 */
@Component
public class SearchIndex {
    private static final Logger log = LoggerFactory.getLogger(SearchIndex.class);
    private static final String INDEX = "collab_documents";

    private final DocumentRepository documents;
    private final ObjectMapper mapper;
    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(3)).build();
    private final String endpoint;
    private volatile boolean ready;

    public SearchIndex(DocumentRepository documents, ObjectMapper mapper,
                       @Value("${spring.elasticsearch.uris}") String endpoint) {
        this.documents = documents;
        this.mapper = mapper;
        this.endpoint = endpoint.replaceAll("/+$", "");
    }

    public void upsert(long docId) {
        write(docId, true);
    }

    private void write(long docId, boolean refresh) {
        ensureIndex();
        DocumentRow row = documents.find(docId).orElse(null);
        if (row == null) {
            Response response = send("DELETE", "/" + INDEX + "/_doc/" + docId, null);
            if (response.status != 200 && response.status != 404) fail(response);
            return;
        }
        ObjectNode source = mapper.createObjectNode()
                .put("id", row.id())
                .put("title", row.title())
                .put("body", plainText(row.content()))
                .put("revision", row.revision());
        Response response = send("PUT", "/" + INDEX + "/_doc/" + docId
                + (refresh ? "?refresh=wait_for" : ""), source);
        if (response.status != 200 && response.status != 201) fail(response);
    }

    public SearchPage search(String query, List<Long> visibleIds, int page, int size) {
        if (visibleIds.isEmpty()) return new SearchPage(0, List.of());
        ensureIndex();
        ObjectNode body = mapper.createObjectNode();
        body.put("from", (page - 1) * size).put("size", size).put("track_total_hits", true);
        ObjectNode bool = body.putObject("query").putObject("bool");
        bool.putObject("must").putObject("multi_match")
                .put("query", query).putArray("fields").add("title^3").add("body");
        ArrayNode ids = bool.putObject("filter").putObject("ids").putArray("values");
        visibleIds.forEach(id -> ids.add(String.valueOf(id)));
        Response response = send("POST", "/" + INDEX + "/_search", body);
        if (response.status != 200) fail(response);
        JsonNode hits = response.body.path("hits");
        long total = hits.path("total").path("value").asLong();
        List<Long> idsFound = new java.util.ArrayList<>();
        for (JsonNode hit : hits.path("hits")) {
            idsFound.add(Long.parseLong(hit.path("_id").asText()));
        }
        return new SearchPage(total, idsFound);
    }

    @Scheduled(initialDelay = 5_000, fixedDelay = 60_000)
    public void rebuild() {
        try {
            // 重新检查整个索引是否仍存在；ES 数据卷重置后也能自动建回映射。
            ready = false;
            ensureIndex();
            for (Long id : documents.allIds()) {
                write(id, false);
            }
            Response refreshed = send("POST", "/" + INDEX + "/_refresh", null);
            if (refreshed.status != 200) fail(refreshed);
        } catch (RuntimeException exception) {
            log.warn("ES 索引巡检暂时失败，下轮重试", exception);
        }
    }

    static String plainText(String deltaJson) {
        if (deltaJson == null) return "";
        try {
            JsonNode root = new ObjectMapper().readTree(deltaJson);
            StringBuilder text = new StringBuilder();
            for (JsonNode op : root.path("ops")) {
                JsonNode insert = op.path("insert");
                if (insert.isTextual()) text.append(insert.asText());
            }
            return text.toString();
        } catch (Exception exception) {
            throw new IllegalStateException("文档 Delta 内容无法索引", exception);
        }
    }

    private synchronized void ensureIndex() {
        if (ready) return;
        Response existing = send("HEAD", "/" + INDEX, null);
        if (existing.status == 200) {
            ready = true;
            return;
        }
        if (existing.status != 404) fail(existing);
        ObjectNode mapping = mapper.createObjectNode();
        ObjectNode properties = mapping.putObject("mappings").putObject("properties");
        properties.putObject("id").put("type", "long");
        properties.putObject("title").put("type", "text");
        properties.putObject("body").put("type", "text");
        properties.putObject("revision").put("type", "long");
        Response created = send("PUT", "/" + INDEX, mapping);
        if (created.status != 200 && !(created.status == 400 &&
                "resource_already_exists_exception".equals(
                        created.body.path("error").path("type").asText()))) fail(created);
        ready = true;
    }

    private Response send(String method, String path, JsonNode body) {
        try {
            HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(endpoint + path))
                    .timeout(Duration.ofSeconds(8));
            if (body == null) {
                request.method(method, HttpRequest.BodyPublishers.noBody());
            } else {
                request.header("Content-Type", "application/json")
                        .method(method, HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(body)));
            }
            HttpResponse<String> response = http.send(request.build(), HttpResponse.BodyHandlers.ofString());
            JsonNode parsed = response.body().isBlank() ? mapper.nullNode() : mapper.readTree(response.body());
            return new Response(response.statusCode(), parsed);
        } catch (Exception exception) {
            throw new IllegalStateException("Elasticsearch 请求失败", exception);
        }
    }

    private static void fail(Response response) {
        throw new IllegalStateException("Elasticsearch 响应错误: HTTP " + response.status + " " + response.body);
    }

    private record Response(int status, JsonNode body) {
    }

    public record SearchPage(long total, List<Long> ids) {
    }
}
