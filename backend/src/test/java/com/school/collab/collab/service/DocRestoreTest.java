package com.school.collab.collab.service;

import com.school.collab.collab.CollabException;
import com.school.collab.ot.Delta;
import com.school.collab.ot.Op;
import org.junit.jupiter.api.Test;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.jupiter.api.Assertions.*;

class DocRestoreTest {
    @Test void richTextRestoreCreatesNewRevisionAndRetryDoesNotReapply() {
        var service = new DocRevService();
        Delta target = new Delta().insert("粗体", Map.of("bold", true))
                .push(Op.insertEmbed(com.fasterxml.jackson.databind.node.JsonNodeFactory.instance.objectNode()
                        .put("image", "http://localhost:9000/collab/test.png")))
                .insert("\n");
        service.commit(1, 0, new Delta().insert("当前正文"));
        var broadcasts = new AtomicInteger();
        var result = service.restore(1, 1, 0, 7, "restore-1", () -> target, ignored -> broadcasts.incrementAndGet());
        assertEquals(2, result.revision());
        assertEquals(target.getOps(), service.snapshot(1).content().getOps());
        service.commit(1, 2, new Delta().insert("恢复之后"));
        var retry = service.restore(1, 1, 0, 7, "restore-1",
                () -> { fail("重试不应重新加载历史正文"); return null; }, ignored -> broadcasts.incrementAndGet());
        assertFalse(retry.applied());
        assertEquals(2, retry.revision());
        assertEquals(3, service.snapshot(1).revision());
        assertEquals(1, broadcasts.get());
    }
    @Test void concurrentEditRejectsRestoreInsteadOfOverwriting() {
        var service = new DocRevService();
        service.commit(1, 0, new Delta().insert("新编辑"));
        var ex = assertThrows(CollabException.class, () -> service.restore(1, 0, 0, 7, "request",
                () -> { fail("过时请求不得加载或覆盖正文"); return null; }, ignored -> fail()));
        assertEquals(40902, ex.getCode());
        assertEquals(1, service.snapshot(1).revision());
    }
    @Test void reusedRestoreIdForAnotherTargetIsRejected() {
        var service = new DocRevService();
        service.commit(1, 0, new Delta().insert("A"));
        service.restore(1, 1, 0, 7, "request", () -> new Delta().insert("\n"), ignored -> {});
        var ex = assertThrows(CollabException.class, () -> service.restore(1, 1, 1, 7, "request",
                () -> new Delta().insert("A\n"), ignored -> {}));
        assertEquals(40904, ex.getCode());
    }
}
