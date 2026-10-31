package com.school.collab.search;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.document.DocumentRepository;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;

class SearchIndexTest {
    private final ObjectMapper mapper = new ObjectMapper();
    private final AtomicReference<JsonNode> submitted = new AtomicReference<>();
    private final AtomicInteger requests = new AtomicInteger();
    private HttpServer server;
    private SearchIndex index;

    @BeforeEach
    void start() throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            requests.incrementAndGet();
            if (exchange.getRequestMethod().equals("HEAD")) {
                exchange.sendResponseHeaders(200, -1);
            } else {
                submitted.set(mapper.readTree(exchange.getRequestBody()));
                byte[] response = "{\"hits\":{\"total\":{\"value\":21},\"hits\":[{\"_id\":\"31\"},{\"_id\":\"30\"}]}}"
                        .getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type", "application/json");
                exchange.sendResponseHeaders(200, response.length);
                exchange.getResponseBody().write(response);
            }
            exchange.close();
        });
        server.start();
        index = new SearchIndex(mock(DocumentRepository.class), mapper,
                "http://127.0.0.1:" + server.getAddress().getPort());
    }

    @AfterEach
    void stop() {
        if (server != null) server.stop(0);
    }

    @Test
    void 跨标题正文要求所有词项并保留权限过滤分页及真实总数() throws Exception {
        var result = index.search("J30 图表说明", List.of(30L, 31L), 2, 10);
        JsonNode body = submitted.get();
        JsonNode match = body.path("query").path("bool").path("must").path("multi_match");
        assertEquals("J30 图表说明", match.path("query").asText());
        assertEquals("cross_fields", match.path("type").asText());
        assertEquals("and", match.path("operator").asText());
        assertEquals(mapper.readTree("[\"title^3\",\"body\"]"), match.path("fields"));
        assertEquals(mapper.readTree("[\"30\",\"31\"]"),
                body.path("query").path("bool").path("filter").path("ids").path("values"));
        assertEquals(10, body.path("from").asInt());
        assertEquals(10, body.path("size").asInt());
        assertTrue(body.path("track_total_hits").asBoolean());
        assertEquals(new SearchIndex.SearchPage(21, List.of(31L, 30L)), result);
    }

    @Test
    void 无可见文档时不向检索引擎发出查询() {
        assertEquals(new SearchIndex.SearchPage(0, List.of()), index.search("交接", List.of(), 1, 10));
        assertEquals(0, requests.get());
    }
}
