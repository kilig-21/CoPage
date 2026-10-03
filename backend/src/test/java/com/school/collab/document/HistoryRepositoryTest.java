package com.school.collab.document;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.collab.CollabException;
import com.school.collab.collab.persist.DocumentPersistence;
import com.school.collab.collab.store.CollabDocumentSnapshot;
import com.school.collab.collab.store.VersionedOperation;
import com.school.collab.ot.Delta;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import java.util.List;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;

class HistoryRepositoryTest {
    private final JdbcTemplate jdbc = mock(JdbcTemplate.class);
    private final DocumentPersistence persistence = mock(DocumentPersistence.class);
    private final HistoryRepository repository = new HistoryRepository(jdbc, new ObjectMapper(), persistence);
    @Test void rebuildsFromNearestSnapshotAndContinuousOperations() {
        doReturn(List.of()).when(jdbc).query(contains("doc_named_version"), any(RowMapper.class), eq(1L), eq(3L));
        doReturn(List.of(2L)).when(jdbc).query(contains("doc_history_boundary"), any(RowMapper.class), eq(1L));
        doReturn(List.of(new CollabDocumentSnapshot(2, new Delta().insert("AB\n"))))
                .when(jdbc).query(contains("doc_snapshot"), any(RowMapper.class), eq(1L), eq(3L));
        when(persistence.operationsBetween(1, 2, 3)).thenReturn(List.of(new VersionedOperation(3, new Delta().retain(2).insert("C"))));
        var content = repository.contentAt(1, 3, new CollabDocumentSnapshot(4, new Delta().insert("ABCD\n")));
        assertEquals(new Delta().insert("ABC\n").getOps(), content.getOps());
    }
    @Test void gapNeverReturnsPartialContent() {
        doReturn(List.of()).when(jdbc).query(contains("doc_named_version"), any(RowMapper.class), eq(1L), eq(3L));
        doReturn(List.of(0L)).when(jdbc).query(contains("doc_history_boundary"), any(RowMapper.class), eq(1L));
        doReturn(List.of()).when(jdbc).query(contains("doc_snapshot"), any(RowMapper.class), eq(1L), eq(3L));
        when(persistence.operationsBetween(1, 0, 3)).thenReturn(List.of(new VersionedOperation(2, new Delta().insert("B"))));
        assertEquals(40903, assertThrows(CollabException.class, () -> repository.contentAt(1, 3,
                new CollabDocumentSnapshot(4, new Delta().insert("ABCD\n")))).getCode());
    }
    @Test void namedVersionSurvivesOrdinaryHistoryFloor() {
        doReturn(List.of(new Delta().insert("重要内容\n"))).when(jdbc).query(contains("doc_named_version"), any(RowMapper.class), eq(1L), eq(3L));
        assertEquals(new Delta().insert("重要内容\n").getOps(), repository.contentAt(1, 3,
                new CollabDocumentSnapshot(100, new Delta().insert("最新\n"))).getOps());
        verifyNoInteractions(persistence);
    }
}
