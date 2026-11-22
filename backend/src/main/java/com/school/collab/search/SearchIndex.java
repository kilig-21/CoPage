package com.school.collab.search;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.school.collab.document.DocumentRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

/** Elasticsearch 只保存可重建的检索副本；授权和当前状态以 MySQL 为准。 */
@Component
public class SearchIndex {
    private static final Logger log = LoggerFactory.getLogger(SearchIndex.class);
    private static final String INDEX = "collab_documents_v2";
    private static final String DOC_PATH = "/" + INDEX + "/_doc/";
    private static final String CHECKPOINT_PATH = DOC_PATH + "copage-rebuild-checkpoint";
    private static final int BATCH_SIZE = 32;

    private final DocumentRepository documents;
    private final ObjectMapper mapper;
    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(3)).build();
    private final String endpoint;
    private volatile boolean ready;
    private long pendingAfter;

    public SearchIndex(DocumentRepository documents, ObjectMapper mapper,
                       @Value("${spring.elasticsearch.uris}") String endpoint) {
        this.documents = documents;
        this.mapper = mapper;
        this.endpoint = endpoint.replaceAll("/+$", "");
    }

    /** Called after a document transaction commits. The index acknowledgement must commit separately. */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void upsert(long docId) {
        write(docId, true);
    }

    private void write(long docId, boolean refresh) {
        ensureIndex();
        var row = documents.findForIndex(docId).orElse(null);
        if (row == null) return;
        // 用无正文的删除标记保留外部版本，迟到的旧写入不能让删除的文档重新出现。
        ObjectNode source = mapper.createObjectNode().put("id", row.id()).put("deleted", row.deleted());
        if (!row.deleted()) {
            source.put("title", row.title()).put("body", plainText(mapper, row.content()))
                    .put("revision", row.revision());
        }
        Response response = send("PUT", DOC_PATH + docId + "?version_type=external&version="
                + row.searchVersion() + (refresh ? "&refresh=wait_for" : ""), source);
        if (!successfulWrite(response) && !versionConflict(response)) fail(response);
        documents.indexed(docId, row.searchVersion());
    }

    public SearchPage search(String query, List<Long> visibleIds, int page, int size) {
        if (visibleIds.isEmpty()) return new SearchPage(0, List.of());
        ensureIndex();
        ObjectNode body = mapper.createObjectNode();
        body.put("from", (page - 1) * size).put("size", size).put("track_total_hits", true);
        ObjectNode bool = body.putObject("query").putObject("bool");
        // 增加关键词应缩小范围；各词项可分别出现在标题或正文中。
        bool.putObject("must").putObject("multi_match")
                .put("query", query).put("type", "cross_fields").put("operator", "and")
                .putArray("fields").add("title^3").add("body");
        ArrayNode ids = bool.putObject("filter").putObject("ids").putArray("values");
        visibleIds.forEach(id -> ids.add(String.valueOf(id)));
        bool.putObject("must_not").putObject("term").put("deleted", true);
        Response response = send("POST", "/" + INDEX + "/_search", body);
        if (response.status != 200) fail(response);
        JsonNode hits = response.body.path("hits");
        long total = hits.path("total").path("value").asLong();
        List<Long> idsFound = new ArrayList<>();
        for (JsonNode hit : hits.path("hits")) {
            idsFound.add(Long.parseLong(hit.path("_id").asText()));
        }
        return new SearchPage(total, idsFound);
    }

    @Scheduled(initialDelay = 5_000, fixedDelayString = "${collab.search.repair-interval-ms:5000}")
    public void rebuild() {
        long started = System.nanoTime();
        try {
            ready = false;
            ensureIndex();
            int rebuilt = advanceRebuild();
            int repaired = 0;
            var pending = documents.pendingIndexIdsAfter(pendingAfter, BATCH_SIZE);
            for (long id : pending) {
                // 即使某条失败，下轮也可继续处理其他文档。失败行保持待处理，游标循环后重试。
                pendingAfter = id;
                write(id, false);
                repaired++;
            }
            if (pending.size() < BATCH_SIZE) pendingAfter = 0;
            if (rebuilt + repaired > 0) {
                log.info("ES 增量巡检完成, rebuilt={}, repaired={}, elapsedMs={}",
                        rebuilt, repaired, Duration.ofNanos(System.nanoTime() - started).toMillis());
            }
        } catch (RuntimeException exception) {
            log.warn("ES 索引巡检暂时失败，下轮重试", exception);
        }
    }

    private int advanceRebuild() {
        Response checkpoint = send("GET", CHECKPOINT_PATH, null);
        if (checkpoint.status != 200 && checkpoint.status != 404) fail(checkpoint);
        JsonNode position = checkpoint.body.path("_source");
        if (position.path("complete").asBoolean()) return 0;

        long cursor = position.path("after").asLong();
        var ids = documents.indexIdsAfter(cursor, BATCH_SIZE);
        for (long id : ids) write(id, false);

        long after = ids.isEmpty() ? cursor : ids.getLast();
        ObjectNode next = mapper.createObjectNode().put("after", after).put("complete", ids.size() < BATCH_SIZE);
        String condition = checkpoint.status == 404 ? "?op_type=create" : "?if_seq_no="
                + checkpoint.body.path("_seq_no").asLong() + "&if_primary_term=" + checkpoint.body.path("_primary_term").asLong();
        Response saved = send("PUT", CHECKPOINT_PATH + condition, next);
        if (!successfulWrite(saved) && !versionConflict(saved)) fail(saved);
        return ids.size();
    }

    static String plainText(ObjectMapper mapper, String deltaJson) {
        if (deltaJson == null) return "";
        try {
            JsonNode root = mapper.readTree(deltaJson);
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
        properties.putObject("deleted").put("type", "boolean");
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
        throw new IllegalStateException("Elasticsearch 响应错误: HTTP " + response.status
                + " " + response.body.path("error").path("type").asText());
    }

    private static boolean successfulWrite(Response response) {
        return response.status == 200 || response.status == 201;
    }

    private static boolean versionConflict(Response response) {
        return response.status == 409 && "version_conflict_engine_exception".equals(response.body.path("error").path("type").asText());
    }

    private record Response(int status, JsonNode body) {
    }

    public record SearchPage(long total, List<Long> ids) {
    }
}
