package com.school.collab.collab.service;

import com.school.collab.collab.CollabException;
import com.school.collab.collab.persist.DocumentPersistence;
import com.school.collab.collab.store.CollabDocumentSnapshot;
import com.school.collab.collab.store.InMemoryDocumentStateStore;
import com.school.collab.collab.store.VersionedOperation;
import com.school.collab.ot.Delta;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class DocJoinStateTest {
    @Test
    void reconnectIdentifiesCommittedPendingWithinOrderedHistory() {
        DocRevService service = new DocRevService();
        service.commit(1, 0, new Delta().insert("B"));
        service.commit(1, 0, new Delta().insert("A"), 7L, "client", "op-1", ignored -> {});
        var state = join(service, 0, new DocRevService.PendingOperation("op-1", 0, new Delta().insert("A")));

        assertTrue(state.historyComplete());
        assertEquals(2, state.revision());
        assertEquals(2L, state.pendingCommittedRevision());
        assertEquals(List.of(1L, 2L), state.history().stream().map(VersionedOperation::revision).toList());
    }

    @Test
    void uncommittedPendingIsNotAcknowledgedAndReusedIdIsRejected() {
        DocRevService service = new DocRevService();
        assertNull(join(service, 0, new DocRevService.PendingOperation(
                "op-1", 0, new Delta().insert("A"))).pendingCommittedRevision());
        service.commit(1, 0, new Delta().insert("A"), 7L, "client", "op-1", ignored -> {});

        CollabException failure = assertThrows(CollabException.class, () -> join(service, 0,
                new DocRevService.PendingOperation("op-1", 0, new Delta().insert("different"))));
        assertEquals(40904, failure.getCode());
    }

    @Test
    void incompleteHistoryIsExplicitAndDoesNotExposePartialReplay() {
        DocumentPersistence persistence = mock(DocumentPersistence.class);
        when(persistence.snapshot(1)).thenReturn(new CollabDocumentSnapshot(3, new Delta().insert("ABC\n")));
        when(persistence.operationsBetween(1, 0, 3)).thenReturn(List.of(
                new VersionedOperation(1, new Delta().insert("A")),
                new VersionedOperation(3, new Delta().insert("C"))));
        var state = join(new DocRevService(new InMemoryDocumentStateStore(), persistence), 0, null);

        assertFalse(state.historyComplete());
        assertTrue(state.history().isEmpty());
        assertEquals(3, state.revision());
    }

    @Test
    void oversizedCatchupDoesNotLoadAnUnboundedHistory() {
        DocumentPersistence persistence = mock(DocumentPersistence.class);
        when(persistence.snapshot(1)).thenReturn(new CollabDocumentSnapshot(2001, new Delta().insert("A\n")));
        var state = join(new DocRevService(new InMemoryDocumentStateStore(), persistence), 0, null);

        assertFalse(state.historyComplete());
        verify(persistence, never()).operationsBetween(anyLong(), anyLong(), anyLong());
    }

    @Test
    void concurrentCommitCannotPassRegistrationAndSyncCallback() throws Exception {
        DocRevService service = new DocRevService();
        CountDownLatch joining = new CountDownLatch(1);
        CountDownLatch releaseSync = new CountDownLatch(1);
        CountDownLatch attemptingCommit = new CountDownLatch(1);
        CountDownLatch committed = new CountDownLatch(1);
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var join = executor.submit(() -> service.joinState(1, 0, 7, "client", null, state -> {
                assertEquals(0, state.revision());
                joining.countDown();
                await(releaseSync);
            }));
            try {
                assertTrue(joining.await(5, TimeUnit.SECONDS));
                var commit = executor.submit(() -> {
                    attemptingCommit.countDown();
                    return service.commit(1, 0, new Delta().insert("A"), result -> committed.countDown());
                });
                assertTrue(attemptingCommit.await(5, TimeUnit.SECONDS));
                assertFalse(committed.await(100, TimeUnit.MILLISECONDS));
                releaseSync.countDown();
                join.get(5, TimeUnit.SECONDS);
                assertEquals(1, commit.get(5, TimeUnit.SECONDS).revision());
            } finally {
                releaseSync.countDown();
            }
        }
    }

    private static DocRevService.JoinState join(DocRevService service, long revision,
                                                DocRevService.PendingOperation pending) {
        AtomicReference<DocRevService.JoinState> result = new AtomicReference<>();
        service.joinState(1, revision, 7, "client", pending, result::set);
        return result.get();
    }

    private static void await(CountDownLatch latch) {
        try {
            if (!latch.await(5, TimeUnit.SECONDS)) throw new AssertionError("同步回调等待超时");
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            throw new AssertionError(exception);
        }
    }
}
