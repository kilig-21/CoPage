package com.school.collab.search;

import com.school.collab.document.DocumentRepository;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.jdbc.core.JdbcTemplate;
import java.util.List;

import static com.school.collab.testsupport.MySqlTestDatabase.createMigrated;
import static org.junit.jupiter.api.Assertions.*;

@EnabledIfEnvironmentVariable(named = "COPAGE_MIGRATION_TEST_MYSQL", matches = ".+")
class SearchRepositoryDatabaseTest {
    @Test
    void pendingBatchesStayBoundedAndOldAcknowledgementsCannotClearNewerChanges() {
        var jdbc = new JdbcTemplate(createMigrated());
        var repository = new DocumentRepository(jdbc);
        jdbc.update("""
                INSERT INTO document (id, title, owner_id)
                WITH RECURSIVE ids(i) AS (SELECT 10001 UNION ALL SELECT i+1 FROM ids WHERE i<30000)
                SELECT /*+ SET_VAR(cte_max_recursion_depth=20001) */ i, 'search-fixture', 1 FROM ids
                """);
        var first = repository.pendingIndexIdsAfter(0, 32);
        assertEquals(32, first.size());
        assertEquals(10001L, first.getFirst());
        assertEquals(10033L, repository.indexIdsAfter(first.getLast(), 32).getFirst());
        long id = first.getFirst();
        var prior = repository.findForIndex(id).orElseThrow();
        assertTrue(repository.rename(id, "new-title"));
        repository.indexed(id, prior.searchVersion());
        assertEquals(List.of(id), repository.pendingIndexIdsAfter(id - 1, 1));

        var newer = repository.findForIndex(id).orElseThrow();
        assertEquals(prior.searchVersion() + 1, newer.searchVersion());
        assertTrue(repository.softDelete(id));
        repository.indexed(id, newer.searchVersion());
        assertTrue(repository.findForIndex(id).orElseThrow().deleted());
        assertEquals(List.of(id), repository.pendingIndexIdsAfter(id - 1, 1));
        assertTrue(repository.restoreDeleted(id, 1));
        var restored = repository.findForIndex(id).orElseThrow();
        assertFalse(restored.deleted());
        assertEquals(newer.searchVersion() + 2, restored.searchVersion());
        repository.indexed(id, restored.searchVersion());
        assertEquals(List.of(id + 1), repository.pendingIndexIdsAfter(id - 1, 1));
    }
}
