package com.school.collab.collab.service;

import com.school.collab.ot.Delta;
import com.school.collab.ot.Op;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

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

    private static String text(Delta delta) {
        return delta.getOps().stream()
                .filter(Op::isTextInsert)
                .map(Op::text)
                .reduce("", String::concat);
    }
}
