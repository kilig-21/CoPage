package com.school.collab.document;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.collab.CollabException;
import com.school.collab.collab.persist.DocumentPersistence;
import com.school.collab.collab.service.DocRevService;
import com.school.collab.collab.store.InMemoryDocumentStateStore;
import com.school.collab.ot.Delta;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.List;

import static com.school.collab.testsupport.MySqlTestDatabase.createMigrated;
import static org.junit.jupiter.api.Assertions.*;

@EnabledIfEnvironmentVariable(named = "COPAGE_MIGRATION_TEST_MYSQL", matches = ".+")
class HistoryRetentionDatabaseTest {
    private final ObjectMapper mapper = new ObjectMapper();
    private JdbcTemplate jdbc;
    private DocumentPersistence persistence;
    private HistoryRepository history;
    private DocRevService revisions;

    @BeforeEach
    void prepare() {
        jdbc = new JdbcTemplate(createMigrated());
        persistence = new DocumentPersistence(jdbc, mapper);
        history = new HistoryRepository(jdbc, mapper, persistence);
        revisions = new DocRevService(new InMemoryDocumentStateStore(), persistence);
    }

    @Test
    void activeMaintenanceTrimsSnapshotsAndAgedOperationsWhileKeepingBaselineAndNamedVersion() throws Exception {
        long ordinary = 8101;
        long protectedDocument = 8102;
        seed(ordinary, 6);
        seed(protectedDocument, 6);
        var job = new HistoryMaintenance(history, revisions, mapper, true, 30, 10_000, 4, 67_108_864, "8102");

        job.maintain();

        assertEquals(List.of(6L, 10L, 11L, 12L), snapshots(ordinary));
        assertEquals(6L, history.floor(ordinary));
        assertEquals(6L, jdbc.queryForObject("SELECT COUNT(*) FROM doc_operation WHERE doc_id = ?", Long.class, ordinary));
        assertEquals(6L, jdbc.queryForObject("SELECT COUNT(*) FROM doc_operation_receipt WHERE doc_id = ?", Long.class, ordinary));
        var current = persistence.snapshot(ordinary);
        assertEquals(body(12).getOps(), current.content().getOps());
        assertEquals(body(6).getOps(), history.contentAt(ordinary, 6, current).getOps());
        assertEquals(body(8).getOps(), history.contentAt(ordinary, 8, current).getOps());
        assertEquals(body(1).getOps(), history.contentAt(ordinary, 1, current).getOps());
        assertEquals(40903, assertThrows(CollabException.class, () -> history.contentAt(ordinary, 2, current)).getCode());
        assertEquals(List.of(0L, 1L, 2L, 3L, 4L, 5L, 8L, 10L, 11L, 12L), snapshots(protectedDocument));
        assertEquals(0L, history.floor(protectedDocument));
        assertEquals(12L, jdbc.queryForObject("SELECT COUNT(*) FROM doc_operation WHERE doc_id = ?", Long.class, protectedDocument));
    }

    @Test
    void snapshotCapAloneKeepsRevisionZeroAndRefusesToTrimAnInconsistentHistory() throws Exception {
        long healthy = 8103;
        long gap = 8104;
        seed(healthy, 0);
        seed(gap, 0);
        jdbc.update("DELETE FROM doc_operation WHERE doc_id = ? AND revision = 2", gap);
        var previous = snapshots(gap);

        assertEquals(6, history.trimPeriodicSnapshots(healthy, 4));
        assertEquals(List.of(0L, 10L, 11L, 12L), snapshots(healthy));
        assertEquals(body(5).getOps(), history.contentAt(healthy, 5, persistence.snapshot(healthy)).getOps());
        assertEquals(40903, assertThrows(CollabException.class, () -> history.trimPeriodicSnapshots(gap, 4)).getCode());
        assertEquals(previous, snapshots(gap));
    }

    @Test
    void replayAcceptsCurrentBaseAfterAllOrdinaryHistoryAgesOut() throws Exception {
        long doc = 8105;
        seed(doc, 12);
        new HistoryMaintenance(history, revisions, mapper, true, 30, 10_000, 4, 67_108_864, "").maintain();

        assertEquals(List.of(12L), snapshots(doc));
        assertEquals(12L, history.floor(doc));
        assertTrue(revisions.historyPage(doc, 12, 12).history().isEmpty());
        assertEquals(40903, assertThrows(CollabException.class, () -> revisions.historyPage(doc, 11, 12)).getCode());
        assertEquals(13L, revisions.commit(doc, 12, new Delta().insert("N")).revision());
    }

    private void seed(long doc, int aged) throws Exception {
        jdbc.update("INSERT INTO document (id, content, revision, owner_id) VALUES (?, ?, 12, 1)",
                doc, mapper.writeValueAsString(body(12)));
        for (int revision = 1; revision <= 12; revision++) {
            jdbc.update("INSERT INTO doc_operation (doc_id, revision, op, create_time) VALUES (?, ?, ?, DATE_SUB(NOW(), INTERVAL ? DAY))",
                    doc, revision, mapper.writeValueAsString(new Delta().insert("A")), revision <= aged ? 40 : 0);
            jdbc.update("INSERT INTO doc_operation_receipt (doc_id, user_id, client_id, op_id, revision) VALUES (?, 1, 'retention-test', ?, ?)",
                    doc, String.valueOf(revision), revision);
        }
        for (int revision : List.of(0, 1, 2, 3, 4, 5, 8, 10, 11, 12)) {
            jdbc.update("INSERT INTO doc_snapshot (doc_id, revision, content) VALUES (?, ?, ?)",
                    doc, revision, mapper.writeValueAsString(body(revision)));
        }
        history.name(doc, 1, "合成重要版本", 1, body(1));
    }

    private List<Long> snapshots(long doc) {
        return jdbc.queryForList("SELECT revision FROM doc_snapshot WHERE doc_id = ? ORDER BY revision", Long.class, doc);
    }

    private Delta body(int revision) {
        return new Delta().insert("A".repeat(revision) + "\n");
    }
}
