package com.school.collab.collab.service;
import com.school.collab.collab.CollabException;
import com.school.collab.collab.persist.DocumentPersistence;
import com.school.collab.collab.store.CollabDocumentSnapshot;
import com.school.collab.collab.store.InMemoryDocumentStateStore;
import com.school.collab.collab.store.VersionedOperation;
import com.school.collab.ot.Delta;
import org.junit.jupiter.api.Test;
import java.time.Duration;
import java.util.List;
import java.util.stream.LongStream;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class DocHistoryPageTest {
    @Test void livePageAuthenticatesThePendingReceiptWithinItsFixedBoundary() {
        var service = new DocRevService();
        var original = new Delta().insert("local");
        service.commit(1, 0, new Delta().insert("remote"));
        service.commit(1, 0, original, 7L, "client", "local-1", ignored -> {});
        var pending = new DocRevService.PendingOperation("local-1", 0, original);

        assertNull(service.historyPage(1, 0, 1, 7, "client", pending).pendingCommittedRevision());
        assertEquals(2L, service.historyPage(1, 0, 2, 7, "client", pending).pendingCommittedRevision());
        assertNull(service.historyPage(1, 0, 2, 99, "client", pending).pendingCommittedRevision());
        assertEquals(40904, assertThrows(CollabException.class, () -> service.historyPage(1, 0, 2, 7, "client",
                new DocRevService.PendingOperation("local-1", 0, new Delta().insert("different")))).getCode());
    }

    @Test void pagedCatchupReadsOnlyFixedBoundaryAndRejectsTrimmedBases() {
        var persistence = mock(DocumentPersistence.class);
        when(persistence.snapshot(1)).thenReturn(new CollabDocumentSnapshot(3005,new Delta().insert("正文\n")));
        when(persistence.operationsPage(1,2000,3000,256)).thenReturn(List.of(new VersionedOperation(2001,new Delta().insert("A"))));
        var service = new DocRevService(new InMemoryDocumentStateStore(),persistence);
        var page = service.historyPage(1,2000,3000);
        assertEquals(3000,page.revision()); assertEquals(2001,page.toRevision());
        verify(persistence).operationsPage(1,2000,3000,256);
        when(persistence.minimumRevision(1)).thenReturn(2100L);
        assertEquals(40903,assertThrows(CollabException.class,()->service.historyPage(1,2000,3000)).getCode());
        assertEquals(40903,assertThrows(CollabException.class,()->service.commit(1,2000,new Delta().insert("旧"))).getCode());
    }
    @Test void partialTailAndGapsAreRejected() {
        var persistence=mock(DocumentPersistence.class);
        when(persistence.snapshot(1)).thenReturn(new CollabDocumentSnapshot(3,new Delta().insert("正文\n")));
        when(persistence.operationsPage(1,0,3,256)).thenReturn(List.of(new VersionedOperation(2,new Delta().insert("A"))));
        var service=new DocRevService(new InMemoryDocumentStateStore(),persistence);
        assertEquals(40903,assertThrows(CollabException.class,()->service.historyPage(1,0,3)).getCode());
    }

    @Test void staleCommitRejectsBeforeFetchingHistoryAndCurrentEditorCanContinue() {
        var persistence = mock(DocumentPersistence.class);
        when(persistence.snapshot(1)).thenReturn(new CollabDocumentSnapshot(50_000, new Delta().insert("正文\n")));
        var service = new DocRevService(new InMemoryDocumentStateStore(), persistence);

        assertTimeout(Duration.ofSeconds(1), () -> {
            var error = assertThrows(CollabException.class, () -> service.commit(1, 0, new Delta().insert("旧")));
            assertEquals(40903, error.getCode());
        });
        verify(persistence, never()).operationsBatch(anyLong(), anyLong(), anyLong(), anyInt());
        verify(persistence, never()).persist(anyLong(), anyLong(), any(), any(), isNull());

        assertEquals(50_001, service.commit(1, 50_000, new Delta().insert("新")).revision());
        verify(persistence).persist(eq(1L), eq(50_000L), any(), any(), isNull());
        verify(persistence, never()).operationsBatch(anyLong(), anyLong(), anyLong(), anyInt());
    }

    @Test void uncommittedOperationStillRebasesAcrossTheLongReconnectWindow() {
        int revision = 2_005;
        var persistence = mock(DocumentPersistence.class);
        when(persistence.snapshot(1)).thenReturn(new CollabDocumentSnapshot(revision, new Delta().insert("R".repeat(revision) + "\n")));
        when(persistence.operationsBatch(eq(1L), anyLong(), eq((long) revision), eq(32))).thenAnswer(call -> {
            long after = call.getArgument(1);
            var operations = LongStream.rangeClosed(after + 1, Math.min(after + 32, revision))
                    .mapToObj(value -> new VersionedOperation(value, new Delta().insert("R"))).toList();
            return new DocumentPersistence.OperationBatch(operations, operations.size() * 24L);
        });
        var service = new DocRevService(new InMemoryDocumentStateStore(), persistence);

        assertEquals(revision + 1, service.commit(1, 0, new Delta().insert("A")).revision());
        verify(persistence, times(63)).operationsBatch(eq(1L), anyLong(), eq((long) revision), eq(32));
        verify(persistence).persist(eq(1L), eq((long) revision),
                argThat(content -> content.getOps().getFirst().text().equals("R".repeat(revision) + "A\n")), any(), isNull());
    }

    @Test void rebaseRejectsGapAndCumulativeByteBudgetWithoutWriting() {
        var persistence = mock(DocumentPersistence.class);
        when(persistence.snapshot(1)).thenReturn(new CollabDocumentSnapshot(6, new Delta().insert("正文\n")));
        var service = new DocRevService(new InMemoryDocumentStateStore(), persistence);
        when(persistence.operationsBatch(1, 0, 6, 32)).thenReturn(new DocumentPersistence.OperationBatch(
                List.of(new VersionedOperation(2, new Delta().insert("R"))), 24));
        assertEquals(40903, assertThrows(CollabException.class, () -> service.commit(1, 0, new Delta().insert("A"))).getCode());

        when(persistence.operationsBatch(eq(1L), anyLong(), eq(6L), eq(32))).thenAnswer(call -> {
            long after = call.getArgument(1);
            return new DocumentPersistence.OperationBatch(
                    List.of(new VersionedOperation(after + 1, new Delta().insert("R"))), 4 * 1024 * 1024);
        });
        var failure = assertThrows(CollabException.class, () -> service.commit(1, 0, new Delta().insert("A")));
        assertEquals(40903, failure.getCode());
        assertTrue(failure.getMessage().contains("安全范围"));
        verify(persistence, never()).operationsBatch(1, 5, 6, 32);
        verify(persistence, never()).persist(anyLong(), anyLong(), any(), any(), isNull());
    }
}
