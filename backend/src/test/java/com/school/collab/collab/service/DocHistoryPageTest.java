package com.school.collab.collab.service;
import com.school.collab.collab.CollabException;
import com.school.collab.collab.persist.DocumentPersistence;
import com.school.collab.collab.store.CollabDocumentSnapshot;
import com.school.collab.collab.store.InMemoryDocumentStateStore;
import com.school.collab.collab.store.VersionedOperation;
import com.school.collab.ot.Delta;
import org.junit.jupiter.api.Test;
import java.util.List;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class DocHistoryPageTest {
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
}
