package com.school.collab.collab.service;

import com.school.collab.collab.persist.DocumentPersistence;
import com.school.collab.collab.store.CollabDocumentSnapshot;
import com.school.collab.collab.store.InMemoryDocumentStateStore;
import com.school.collab.collab.store.VersionedOperation;
import com.school.collab.ot.Delta;
import com.school.collab.ot.Op;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class DocRevServiceTest {

    @Test
    void 同一版本并发插入应按服务端提交顺序收敛() {
        DocRevService service = new DocRevService();

        DocRevService.CommitResult first = service.commit(1, 0, new Delta().insert("X"));
        DocRevService.CommitResult second = service.commit(1, 0, new Delta().insert("Y"));
        DocRevService.Snapshot snapshot = service.snapshot(1);

        assertEquals(1, first.revision());
        assertEquals(2, second.revision());
        assertEquals("XY\n", text(snapshot.content()));
    }

    @Test
    void Redis缓存丢失后仍应以MySQL历史变换旧操作() {
        DocumentPersistence persistence = mock(DocumentPersistence.class);
        when(persistence.snapshot(7)).thenReturn(
                new CollabDocumentSnapshot(1, new Delta().insert("X\n")));
        when(persistence.operationsAfter(7, 0)).thenReturn(
                List.of(new VersionedOperation(1, new Delta().insert("X"))));
        DocRevService service = new DocRevService(new InMemoryDocumentStateStore(), persistence);

        DocRevService.CommitResult result = service.commit(7, 0, new Delta().insert("Y"));

        assertEquals(2, result.revision());
        verify(persistence).persist(eq(7L), eq(1L),
                org.mockito.ArgumentMatchers.argThat(content -> "XY\n".equals(text(content))),
                any(Delta.class), eq(null));
    }

    private static String text(Delta delta) {
        return delta.getOps().stream()
                .filter(Op::isTextInsert)
                .map(Op::text)
                .reduce("", String::concat);
    }
}
