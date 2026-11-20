package com.school.collab.collab.persist;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.collab.CollabException;
import com.school.collab.collab.service.DocRevService;
import com.school.collab.collab.store.InMemoryDocumentStateStore;
import com.school.collab.collab.store.VersionedOperation;
import com.school.collab.ot.Delta;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.init.ResourceDatabasePopulator;

import java.time.Duration;
import java.util.List;
import java.util.stream.LongStream;

import static com.school.collab.testsupport.MySqlTestDatabase.create;
import static org.junit.jupiter.api.Assertions.*;

@EnabledIfEnvironmentVariable(named = "COPAGE_MIGRATION_TEST_MYSQL", matches = ".+")
class DocumentPersistenceHistoryTest {
    @Test
    void largeHistoryDoesNotPreventCurrentEditsAndStillPaginates() throws Exception {
        var db = freshDatabase();
        var mapper = new ObjectMapper();
        int current = 20_000;
        long docId = 7801;
        db.update("INSERT INTO document (id, content, revision, owner_id) VALUES (?, ?, ?, 1)",
                docId, mapper.writeValueAsString(new Delta().insert("存量\n")), current);
        var operation = mapper.writeValueAsString(new Delta().retain(1));
        db.batchUpdate("INSERT INTO doc_operation (doc_id, revision, op) VALUES (?, ?, ?)",
                LongStream.rangeClosed(1, current).boxed().toList(), 1_000, (statement, revision) -> {
                    statement.setLong(1, docId);
                    statement.setLong(2, revision);
                    statement.setString(3, operation);
                });
        var persistence = new DocumentPersistence(db, mapper);
        var service = new DocRevService(new InMemoryDocumentStateStore(), persistence);
        assertEquals(current, service.historyPage(docId, 0, current).revision());
        assertEquals(256, service.historyPage(docId, 0, current).toRevision());

        assertTimeout(Duration.ofSeconds(4), () -> {
            assertEquals(40903, assertThrows(CollabException.class,
                    () -> service.commit(docId, 0, new Delta().insert("过时"))).getCode());
            assertEquals(current + 1, service.commit(docId, current, new Delta().insert("当前")).revision());
        });
        assertEquals(current + 1, persistence.currentRevision(docId));
    }

    @Test
    void mysqlPageBudgetsUtf8BytesAndResumesAfterASingleLargeOperation() throws Exception {
        var db = freshDatabase();
        var mapper = new ObjectMapper();
        long docId = 7802;
        String large = mapper.writeValueAsString(new Delta().insert("中".repeat(400_000)));
        String small = mapper.writeValueAsString(new Delta().retain(1));
        db.update("INSERT INTO doc_operation (doc_id, revision, op) VALUES (?, 1, ?), (?, 2, ?), (?, 3, ?)",
                docId, large, docId, small, docId, small);
        var persistence = new DocumentPersistence(db, mapper);

        var firstPage = persistence.operationsBatch(docId, 0, 3, 32);
        assertEquals(List.of(1L), firstPage.operations().stream().map(VersionedOperation::revision).toList());
        assertTrue(firstPage.bytes() > 1024 * 1024);
        var secondPage = persistence.operationsBatch(docId, 1, 2, 32);
        assertEquals(List.of(2L), secondPage.operations().stream().map(VersionedOperation::revision).toList());
    }

    private JdbcTemplate freshDatabase() {
        var dataSource = create();
        var schema = new ResourceDatabasePopulator(new ClassPathResource("db/migration/V1__baseline.sql"));
        schema.setSqlScriptEncoding("UTF-8");
        schema.execute(dataSource);
        return new JdbcTemplate(dataSource);
    }
}
