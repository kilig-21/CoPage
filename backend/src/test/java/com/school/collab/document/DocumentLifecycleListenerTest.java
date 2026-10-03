package com.school.collab.document;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.collab.ws.CollabEventBus;
import org.junit.jupiter.api.Test;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;
import static org.junit.jupiter.api.Assertions.*;

class DocumentLifecycleListenerTest {
    @Test
    void renameInvalidatesWithoutLeakingTitleAndFailureDoesNotUndoCommit() {
        var events = mock(CollabEventBus.class);
        var mapper = new ObjectMapper();
        var listener = new DocumentLifecycleListener(events, mapper);
        listener.renamed(new DocumentService.DocumentRenamed(5));
        verify(events).publish(5L, "", mapper.createObjectNode().put("type", "metadata").put("docId", 5L));
        doThrow(new IllegalStateException("offline")).when(events).publish(eq(5L), anyString(), any());
        assertDoesNotThrow(() -> listener.renamed(new DocumentService.DocumentRenamed(5)));
    }

    @Test
    void deletionNotifiesWholeDocumentAndBroadcastFailureDoesNotUndoCommit() {
        var events=mock(CollabEventBus.class);
        var mapper=new ObjectMapper();
        var listener=new DocumentLifecycleListener(events,mapper);
        listener.deleted(new DocumentService.DocumentDeleted(5));
        verify(events).publish(5L,"",mapper.createObjectNode().put("type","permission").put("docId",5L));
        doThrow(new IllegalStateException("offline")).when(events).publish(eq(5L),anyString(),any());
        assertDoesNotThrow(()->listener.deleted(new DocumentService.DocumentDeleted(5)));
    }
}
