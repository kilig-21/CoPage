package com.school.collab.search;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.document.DocumentRepository;
import com.school.collab.document.DocumentRepository.SearchRow;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.ConfigDataApplicationContextInitializer;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class SearchRepairTest {
    private static final String DOC_PATH = "/collab_documents_v2/_doc/";
    private static final String CHECKPOINT = DOC_PATH + "copage-rebuild-checkpoint";
    private final ObjectMapper mapper = new ObjectMapper();
    private final DocumentRepository documents = mock(DocumentRepository.class);
    private HttpServer server;
    private SearchIndex index;

    @BeforeEach
    void setup() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/collab_documents_v2", call -> reply(call, 200, ""));
        server.start();
        index = new SearchIndex(documents, mapper, "http://127.0.0.1:" + server.getAddress().getPort());
    }

    @AfterEach
    void shutdown() {
        server.stop(0);
    }

    @Test
    void duplicateAndLateWritesCannotReplaceANewerDeletionMarker() {
        var appliedVersion = new AtomicLong();
        var appliedBody = new AtomicReference<String>();
        server.createContext(DOC_PATH + "7", call -> {
            String query = call.getRequestURI().getQuery();
            long version = Long.parseLong(query.split("version=")[1].split("&")[0]);
            String body = new String(call.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            if (version <= appliedVersion.get()) {
                reply(call, 409, "{\"error\":{\"type\":\"version_conflict_engine_exception\"}}");
            } else {
                appliedVersion.set(version);
                appliedBody.set(body);
                reply(call, 200, "{}");
            }
        });
        when(documents.findForIndex(7)).thenReturn(Optional.of(row(7, 3, true)), Optional.of(row(7, 2, false)),
                Optional.of(row(7, 3, true)));
        server.createContext(CHECKPOINT, call -> reply(call, 200, "{\"_source\":{\"complete\":true}}"));
        when(documents.pendingIndexIdsAfter(0, 32)).thenReturn(List.of(7L));

        index.upsert(7);
        index.rebuild();
        index.rebuild();

        assertEquals(3, appliedVersion.get());
        assertEquals("{\"id\":7,\"deleted\":true}", appliedBody.get());
        verify(documents, times(2)).indexed(7, 3);
        verify(documents).indexed(7, 2);
    }

    @Test
    void boundedColdRebuildResumesWithDurableCheckpointAndRetriesAnUnconfirmedWrite() {
        var checkpoint = new AtomicReference<String>();
        server.createContext(CHECKPOINT, call -> {
            if ("GET".equals(call.getRequestMethod())) {
                String value = checkpoint.get();
                if (value == null) reply(call, 404, "{}");
                else reply(call, 200, "{\"_seq_no\":5,\"_primary_term\":1,\"_source\":" + value + "}");
            } else {
                checkpoint.set(new String(call.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
                reply(call, 201, "{}");
            }
        });
        var failing = new AtomicBoolean(true);
        server.createContext(DOC_PATH + "11", call -> reply(call, failing.get() ? 503 : 200, "{}"));
        when(documents.indexIdsAfter(0, 32)).thenReturn(List.of(11L));
        when(documents.findForIndex(11)).thenReturn(Optional.of(row(11, 1, false)));
        index.rebuild();
        assertNull(checkpoint.get());
        verify(documents, never()).indexed(anyLong(), anyLong());

        failing.set(false);
        index.rebuild();
        index.rebuild();

        assertEquals("{\"after\":11,\"complete\":true}", checkpoint.get());
        verify(documents, times(2)).indexIdsAfter(0, 32);
        verify(documents).indexed(11, 1);
        verify(documents, times(2)).pendingIndexIdsAfter(0, 32);
    }

    @Test
    void scheduledMaintenanceHasIndependentCapacity() {
        new ApplicationContextRunner().withInitializer(new ConfigDataApplicationContextInitializer()).run(app ->
                assertEquals(4, app.getEnvironment().getProperty("spring.task.scheduling.pool.size", Integer.class)));
    }

    private SearchRow row(long id, long version, boolean deleted) {
        return new SearchRow(id, "合成标题", "{\"ops\":[{\"insert\":\"合成正文\"}]}", 0, deleted, version);
    }

    private static void reply(HttpExchange call, int status, String body) throws IOException {
        byte[] response = body.getBytes(StandardCharsets.UTF_8);
        if (response.length == 0) call.sendResponseHeaders(status, -1);
        else {
            call.sendResponseHeaders(status, response.length);
            call.getResponseBody().write(response);
        }
        call.close();
    }
}
