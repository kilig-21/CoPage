package com.school.collab.document;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.List;

import static com.school.collab.testsupport.MySqlTestDatabase.createMigrated;
import static org.junit.jupiter.api.Assertions.assertEquals;

@EnabledIfEnvironmentVariable(named = "COPAGE_MIGRATION_TEST_MYSQL", matches = ".+")
class DocumentVisibilityDatabaseTest {
    @Test
    void listingAndCountsApplyTheSameVisibilityFilteringAndStablePagination() {
        var jdbc = new JdbcTemplate(createMigrated());
        var repository = new DocumentRepository(jdbc);
        jdbc.update("""
                INSERT INTO user(id, username, password, nickname) VALUES
                    (1, 'reader', 'fixture', 'Reader'), (2, 'contributor', 'fixture', 'Contributor')
                """);
        jdbc.update("""
                INSERT INTO document(id, title, owner_id, is_deleted, update_time) VALUES
                    (101, 'owned %_ literal', 1, 0, '2026-07-01 12:00:00'),
                    (102, 'owned other', 1, 0, '2026-07-01 12:00:00'),
                    (103, 'shared %_ read', 2, 0, '2026-07-01 12:00:00'),
                    (104, 'shared other edit', 2, 0, '2026-07-01 12:00:00'),
                    (105, 'shared %_ deleted', 2, 1, '2026-07-03 12:00:00'),
                    (106, 'owned %_ deleted', 1, 1, '2026-07-03 12:00:00'),
                    (107, 'private %_ document', 2, 0, '2026-07-03 12:00:00')
                """);
        jdbc.update("""
                INSERT INTO doc_collaborator(doc_id, user_id, permission) VALUES
                    (101, 1, 1), (103, 1, 1), (104, 1, 2), (105, 1, 2), (107, 2, 2)
                """);

        assertEquals(4, repository.countVisible(1, "", "all"));
        assertEquals(2, repository.countVisible(1, "", "owned"));
        assertEquals(2, repository.countVisible(1, "", "shared"));
        assertEquals(2, repository.countVisible(1, "%_", "all"));
        assertEquals(1, repository.countVisible(1, "%_", "owned"));
        assertEquals(1, repository.countVisible(1, "%_", "shared"));
        assertEquals(0, repository.countVisible(1, "private", "all"));

        var first = repository.listVisible(1, "", "all", 1, 2);
        var second = repository.listVisible(1, "", "all", 2, 2);
        assertEquals(List.of(104L, 103L), ids(first));
        assertEquals(List.of(102L, 101L), ids(second));
        assertEquals(List.of(2, 1), first.stream().map(DocumentRepository.VisibleSummaryRow::permission).toList());
        assertEquals(List.of("Contributor", "Contributor"), first.stream().map(DocumentRepository.VisibleSummaryRow::ownerName).toList());
        assertEquals(List.of(2, 2), second.stream().map(DocumentRepository.VisibleSummaryRow::permission).toList());
        assertEquals(List.of(103L, 101L), ids(repository.listVisible(1, "%_", "all", 1, 20)));
        assertEquals(List.of(102L, 101L), ids(repository.listVisible(1, "", "owned", 1, 20)));
        assertEquals(List.of(104L, 103L), ids(repository.listVisible(1, "", "shared", 1, 20)));
        assertEquals(List.of(), repository.listVisible(1, "private", "all", 1, 20));
    }

    private static List<Long> ids(List<DocumentRepository.VisibleSummaryRow> summaries) {
        return summaries.stream().map(DocumentRepository.VisibleSummaryRow::id).toList();
    }
}
