package com.school.collab.document;

import com.school.collab.collab.presence.RedisPresenceStore;
import com.school.collab.collab.store.RedisDocumentStateStore;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.Optional;
import java.util.function.Supplier;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class DeletedDocumentCacheTest {
    private final DocumentRepository documents = mock(DocumentRepository.class);
    private final RedisDocumentStateStore state = mock(RedisDocumentStateStore.class);
    private final RedisPresenceStore presence = mock(RedisPresenceStore.class);
    private final DeletedDocumentCache cache = new DeletedDocumentCache(documents, state, presence);

    @BeforeEach
    void runUnderDocumentLock() {
        when(state.withDocumentLock(eq(5L), any())).thenAnswer(call -> call.<Supplier<?>>getArgument(1).get());
    }

    @Test
    void clearsPresenceAndOnlyEvictsStateCoveredByMysql() {
        when(documents.lockDeletedRevision(5L)).thenReturn(Optional.of(8L));

        cache.clearIfDeleted(5L);

        verify(state).evictDurableState(5L, 8L);
        verify(presence).clear(5L);
    }

    @Test
    void skipsCleanupWhenRestoreAlreadyCommitted() {
        when(documents.lockDeletedRevision(5L)).thenReturn(Optional.empty());

        cache.clearIfDeleted(5L);

        verify(state).withDocumentLock(eq(5L), any());
        org.mockito.Mockito.verifyNoMoreInteractions(state);
        verifyNoInteractions(presence);
    }
}
