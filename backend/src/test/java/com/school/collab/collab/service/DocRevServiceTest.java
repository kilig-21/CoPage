package com.school.collab.collab.service;

import com.school.collab.collab.CollabException;
import com.school.collab.collab.persist.DocumentPersistence;
import com.school.collab.collab.persist.DocPersistenceQueue;
import com.school.collab.collab.persist.OperationFingerprint;
import com.school.collab.collab.store.CollabDocumentSnapshot;
import com.school.collab.collab.store.InMemoryDocumentStateStore;
import com.school.collab.collab.store.VersionedOperation;
import com.school.collab.ot.Delta;
import com.school.collab.ot.Op;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.verifyNoMoreInteractions;
import static org.mockito.Mockito.when;

class DocRevServiceTest {

    @Test
    void 恢复后晚到旧基线插入仍位于末尾换行之前并且原请求只确认一次() {
        DocRevService service = new DocRevService();
        service.commit(70, 0, new Delta().insert("当前正文"));
        AtomicInteger callbacks = new AtomicInteger();
        var restored = service.restore(70, 1, 0, 1, "restore-diff", () -> new Delta().insert("历史版本\n"), ignored -> callbacks.incrementAndGet());
        assertEquals(2, restored.revision());
        var late = service.commit(70, 1, new Delta().retain(4).insert("晚到"), 2L, "peer", "late", ignored -> callbacks.incrementAndGet());
        assertEquals(3, late.revision());
        assertEquals("历史版本晚到\n", text(service.snapshot(70).content()));
        assertFalse(service.restore(70, 1, 0, 1, "restore-diff", () -> { throw new AssertionError("重放必须先读收据"); }, ignored -> callbacks.incrementAndGet()).applied());
        assertFalse(service.commit(70, 1, new Delta().retain(4).insert("晚到"), 2L, "peer", "late", ignored -> callbacks.incrementAndGet()).applied());
        assertEquals(2, callbacks.get()); assertEquals(3, service.snapshot(70).revision());
    }

    @Test
    void 恢复保留共同文字身份而不吞掉晚到格式且版本冲突不调用目标工厂() {
        DocRevService service = new DocRevService();
        service.commit(71, 0, new Delta().insert("共享旧段"));
        service.restore(71, 1, 0, 1, "restore-format", () -> new Delta().insert("共享新段\n"), ignored -> { });
        service.commit(71, 1, new Delta().retain(2, Map.of("bold", true)));
        assertEquals(new Delta().insert("共享", Map.of("bold", true)).insert("新段\n").getOps(), service.snapshot(71).content().getOps());
        assertEquals(40902, assertThrows(CollabException.class, () -> service.restore(71, 1, 0, 1, "stale",
                () -> { throw new AssertionError("版本门禁必须先于diff"); }, ignored -> { })).getCode());
        assertEquals(40904, assertThrows(CollabException.class, () -> service.restore(71, 1, 1, 1, "restore-format",
                () -> { throw new AssertionError("原UUID指纹必须先于diff"); }, ignored -> { })).getCode());
    }

    @Test
    void 恢复相同内容仍生成一个新版本并可继续接收旧基线编辑() {
        DocRevService service = new DocRevService();
        service.restore(72, 0, 0, 1, "same", () -> new Delta().insert("\n"), ignored -> { });
        assertEquals(1, service.snapshot(72).revision());
        service.commit(72, 0, new Delta().insert("仍能编辑"));
        assertEquals("仍能编辑\n", text(service.snapshot(72).content()));
    }

    @Test
    void 普通两万字整体改写也能恢复且同请求仅确认一次() {
        var store = new InMemoryDocumentStateStore();
        DocRevService service = new DocRevService(store, null);
        Delta before = new Delta().insert("会议记录：讨论项目进度，明确下周任务及负责人。\n".repeat(1000) + "\n");
        Delta target = new Delta().insert("客户访谈：确认产品需求，整理交付计划和验收时间。\n".repeat(1000) + "\n");
        service.commit(73, 0, new Delta().insert(text(before)).delete(1));
        AtomicInteger callbacks = new AtomicInteger();
        assertTrue(service.restore(73, 1, 0, 1, "large-rewrite", () -> target,
                ignored -> callbacks.incrementAndGet()).applied());
        assertEquals(target.getOps(), store.snapshot(73).content().getOps());
        assertEquals(1, store.operationsAfter(73, 1).size());
        assertFalse(service.restore(73, 1, 0, 1, "large-rewrite",
                () -> { throw new AssertionError("大文重放也先读取原收据"); }, ignored -> callbacks.incrementAndGet()).applied());
        assertEquals(2, store.snapshot(73).revision()); assertEquals(1, callbacks.get());
    }

    @Test
    void 末尾换行新增空值格式拒绝时不写持久化收据热状态及通知() {
        DocumentPersistence persistence = mock(DocumentPersistence.class);
        DocPersistenceQueue queue = mock(DocPersistenceQueue.class);
        var store = new InMemoryDocumentStateStore();
        when(persistence.snapshot(74)).thenReturn(new CollabDocumentSnapshot(8, new Delta().insert("正文\n")));
        DocRevService service = new DocRevService(store, persistence, queue);
        AtomicInteger callbacks = new AtomicInteger();
        Delta target = new Delta().insert("正文").insert("\n", java.util.Collections.singletonMap("align", null));
        CollabException failure = assertThrows(CollabException.class, () -> service.restore(74, 8, 2, 1, "terminal-null",
                () -> target, ignored -> callbacks.incrementAndGet()));
        assertEquals(400, failure.getCode()); assertTrue(failure.getMessage().contains("空值格式"));
        assertEquals(0, store.snapshot(74).revision()); assertEquals("\n", text(store.snapshot(74).content()));
        assertTrue(store.operationsAfter(74, 0).isEmpty()); assertEquals(0, callbacks.get());
        verify(persistence).receipt(74, 1, "history-api", "terminal-null");
        verify(persistence).snapshot(74); verify(persistence).minimumRevision(74);
        verifyNoMoreInteractions(persistence); verifyNoInteractions(queue);
    }

    @Test
    void 两MiB正文最坏高碎片恢复在构造百万操作前拒绝且不写数据() throws Exception {
        var mapper = new com.fasterxml.jackson.databind.ObjectMapper();
        int padding = 2 * 1024 * 1024 - mapper.writeValueAsBytes(new Delta().insert("\n")).length;
        String repeated = "abcd".repeat(padding / 4 + 1).substring(0, padding);
        Delta before = new Delta().insert(repeated + "\n"), target = new Delta().insert(repeated.replace('d', 'e') + "\n");
        assertEquals(2 * 1024 * 1024, mapper.writeValueAsBytes(before).length);
        assertEquals(2 * 1024 * 1024, mapper.writeValueAsBytes(target).length);
        DocumentPersistence persistence = mock(DocumentPersistence.class);
        DocPersistenceQueue queue = mock(DocPersistenceQueue.class);
        var store = new InMemoryDocumentStateStore();
        when(persistence.snapshot(75)).thenReturn(new CollabDocumentSnapshot(8, before));
        DocRevService service = new DocRevService(store, persistence, queue);
        AtomicInteger callbacks = new AtomicInteger();
        long started = System.nanoTime();
        CollabException failure = org.junit.jupiter.api.Assertions.assertTimeout(java.time.Duration.ofSeconds(10),
                () -> assertThrows(CollabException.class, () -> service.restore(75, 8, 2, 1, "fragmented",
                        () -> target, ignored -> callbacks.incrementAndGet())));
        assertEquals(400, failure.getCode()); assertTrue(failure.getMessage().contains("单次修改最多 4 MiB"));
        assertEquals(before.getOps(), new Delta().insert(repeated + "\n").getOps());
        assertEquals(0, store.snapshot(75).revision()); assertTrue(store.operationsAfter(75, 0).isEmpty());
        assertEquals(0, callbacks.get());
        verify(persistence).receipt(75, 1, "history-api", "fragmented");
        verify(persistence).snapshot(75); verify(persistence).minimumRevision(75);
        verifyNoMoreInteractions(persistence); verifyNoInteractions(queue);
        System.out.printf("RESTORE_DIFF two-MiB-fragmented-rewrite outcome=operation-capacity-rejected elapsedMs=%.3f%n",
                (System.nanoTime() - started) / 1_000_000.0);
    }

    @Test
    void 恢复操作的精确容量检查在应用正文和生成收据之前执行() {
        DocumentPersistence persistence = mock(DocumentPersistence.class);
        DocPersistenceQueue queue = mock(DocPersistenceQueue.class);
        var store = new InMemoryDocumentStateStore();
        when(persistence.snapshot(76)).thenReturn(new CollabDocumentSnapshot(8, new Delta().insert("正文\n")));
        doThrow(new CollabException(400, "单次修改最多 4 MiB")).when(persistence).validateSize(any(Delta.class), any(Delta.class));
        DocRevService service = new DocRevService(store, persistence, queue);
        AtomicInteger callbacks = new AtomicInteger();
        assertEquals(400, assertThrows(CollabException.class, () -> service.restore(76, 8, 2, 1, "exact-size",
                () -> new Delta().insert("目标\n"), ignored -> callbacks.incrementAndGet())).getCode());
        assertEquals(0, store.snapshot(76).revision()); assertTrue(store.operationsAfter(76, 0).isEmpty());
        assertEquals(0, callbacks.get());
        verify(persistence).receipt(76, 1, "history-api", "exact-size");
        verify(persistence).snapshot(76); verify(persistence).minimumRevision(76);
        verify(persistence).validateSize(any(Delta.class), any(Delta.class));
        verifyNoMoreInteractions(persistence); verifyNoInteractions(queue);
    }

    @Test
    void 持久化拒绝过期权限后不改热状态不确认不广播也不发快照消息() {
        DocumentPersistence persistence = mock(DocumentPersistence.class);
        DocPersistenceQueue queue = mock(DocPersistenceQueue.class);
        var store = new InMemoryDocumentStateStore();
        when(persistence.snapshot(7)).thenReturn(new CollabDocumentSnapshot(0, new Delta().insert("\n")));
        doThrow(new CollabException(403, "当前用户没有文档编辑权限")).when(persistence).persist(
                eq(7L), eq(0L), any(Delta.class), any(Delta.class), eq(2L), eq("client"), eq("op"), any(String.class));
        DocRevService service = new DocRevService(store, persistence, queue);
        AtomicInteger callbacks = new AtomicInteger();
        assertEquals(403, assertThrows(CollabException.class, () -> service.commit(7, 0,
                new Delta().insert("不能落库"), 2L, "client", "op", ignored -> callbacks.incrementAndGet())).getCode());
        assertEquals(0, store.snapshot(7).revision());
        assertEquals("\n", text(store.snapshot(7).content()));
        assertEquals(0, callbacks.get());
        verifyNoInteractions(queue);
    }

    @Test
    void 已落库收据仍只返回原确认而不再次进入权限门禁或写正文() {
        DocumentPersistence persistence = mock(DocumentPersistence.class);
        DocPersistenceQueue queue = mock(DocPersistenceQueue.class);
        Delta operation = new Delta().insert("原操作");
        when(persistence.receipt(7, 2, "client", "op")).thenReturn(
                new DocumentPersistence.Receipt(9, OperationFingerprint.of(0, operation)));
        var store = new InMemoryDocumentStateStore();
        DocRevService service = new DocRevService(store, persistence, queue);
        AtomicInteger callbacks = new AtomicInteger();
        var result = service.commit(7, 0, operation, 2L, "client", "op", ignored -> callbacks.incrementAndGet());
        assertFalse(result.applied());
        assertEquals(9, result.revision());
        assertEquals(0, callbacks.get());
        assertEquals(0, store.snapshot(7).revision());
        verify(persistence).receipt(7, 2, "client", "op");
        verifyNoMoreInteractions(persistence);
        verifyNoInteractions(queue);
    }

    @Test
    void 旧缓存历史补写仍无当前用户且不生成新操作收据() {
        DocumentPersistence persistence = mock(DocumentPersistence.class);
        when(persistence.snapshot(7)).thenReturn(new CollabDocumentSnapshot(0, new Delta().insert("\n")));
        var store = new InMemoryDocumentStateStore();
        Delta operation = new Delta().insert("旧历史");
        store.save(7, new CollabDocumentSnapshot(1, new Delta().insert("旧历史\n")),
                new VersionedOperation(1, operation), 2000);
        DocRevService service = new DocRevService(store, persistence);
        assertEquals(1, service.snapshot(7).revision());
        verify(persistence).snapshot(7);
        verify(persistence).persist(eq(7L), eq(0L),
                org.mockito.ArgumentMatchers.argThat(value -> "旧历史\n".equals(text(value))),
                org.mockito.ArgumentMatchers.argThat(value -> value.getOps().equals(operation.getOps())), eq(null));
        verifyNoMoreInteractions(persistence);
    }

    @Test
    void 所有者恢复仍携原请求身份持久化并只在成功后确认() {
        DocumentPersistence persistence = mock(DocumentPersistence.class);
        when(persistence.snapshot(7)).thenReturn(new CollabDocumentSnapshot(0, new Delta().insert("\n")));
        var store = new InMemoryDocumentStateStore();
        DocRevService service = new DocRevService(store, persistence);
        AtomicInteger callbacks = new AtomicInteger();
        var result = service.restore(7, 0, 0, 2, "restore-request", () -> new Delta().insert("历史正文\n"),
                ignored -> callbacks.incrementAndGet());
        assertTrue(result.applied());
        assertEquals(1, result.revision());
        assertEquals(1, callbacks.get());
        assertEquals("历史正文\n", text(store.snapshot(7).content()));
        verify(persistence).persist(eq(7L), eq(0L),
                org.mockito.ArgumentMatchers.argThat(value -> "历史正文\n".equals(text(value))), any(Delta.class),
                eq(2L), eq("history-api"), eq("restore-request"), any(String.class));
    }

    @Test
    void 文档末尾换行不能被删除或变成图片且拒绝后版本和请求收据不改变() {
        DocRevService service = new DocRevService();
        AtomicInteger callbacks = new AtomicInteger();
        for (Delta operation : List.of(new Delta().delete(1), new Delta().retain(1).insert("末尾文字"),
                new Delta().push(Op.insertEmbed(new com.fasterxml.jackson.databind.ObjectMapper()
                        .createObjectNode().put("image", "https://example.com/a.png"))).delete(1))) {
            CollabException error = assertThrows(CollabException.class, () -> service.commit(
                    13, 0, operation, 1L, "client-1", "request-1", ignored -> callbacks.incrementAndGet()));
            assertEquals(400, error.getCode());
            assertEquals(0, service.snapshot(13).revision());
            assertEquals("\n", text(service.snapshot(13).content()));
        }
        assertEquals(0, callbacks.get());
        // 被拒绝的请求没有预留opId，修正正文后可正常提交。
        assertTrue(service.commit(13, 0, new Delta().insert("正文\n").delete(1),
                1L, "client-1", "request-1", ignored -> callbacks.incrementAndGet()).applied());
        assertEquals(1, callbacks.get());
        assertEquals("正文\n", text(service.snapshot(13).content()));
    }

    @Test
    void 全文替换与空白文档都可保留合法末尾换行() {
        DocRevService service = new DocRevService();
        service.commit(14, 0, new Delta().insert("旧正文"));
        service.commit(14, 1, new Delta().insert("新正文\n").delete(4));
        assertEquals("新正文\n", text(service.snapshot(14).content()));
        service.commit(14, 2, new Delta().insert("\n").delete(4));
        assertEquals("\n", text(service.snapshot(14).content()));
        assertEquals(3, service.snapshot(14).revision());
    }

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

    @Test
    void 相同操作ID和请求重试只提交及回调一次() {
        DocRevService service = new DocRevService();
        AtomicInteger callbacks = new AtomicInteger();

        DocRevService.CommitResult first = service.commit(8, 0, new Delta().insert("X"),
                1L, "client-1", "op-1", ignored -> callbacks.incrementAndGet());
        DocRevService.CommitResult retry = service.commit(8, 0, new Delta().insert("X"),
                1L, "client-1", "op-1", ignored -> callbacks.incrementAndGet());

        assertTrue(first.applied());
        assertFalse(retry.applied());
        assertEquals(1, first.revision());
        assertEquals(first.revision(), retry.revision());
        assertEquals(1, callbacks.get());
        assertEquals(1, service.snapshot(8).revision());
        assertEquals("X\n", text(service.snapshot(8).content()));
    }

    @Test
    void 相同操作ID的不同基线或内容必须拒绝而不能确认旧操作() {
        DocRevService service = new DocRevService();
        AtomicInteger callbacks = new AtomicInteger();
        service.commit(9, 0, new Delta().insert("X"), 1L, "client-1", "op-1",
                ignored -> callbacks.incrementAndGet());

        CollabException changedBase = assertThrows(CollabException.class, () -> service.commit(
                9, 1, new Delta().insert("X"), 1L, "client-1", "op-1",
                ignored -> callbacks.incrementAndGet()));
        CollabException changedContent = assertThrows(CollabException.class, () -> service.commit(
                9, 0, new Delta().insert("Y"), 1L, "client-1", "op-1",
                ignored -> callbacks.incrementAndGet()));

        assertEquals(40904, changedBase.getCode());
        assertEquals(40904, changedContent.getCode());
        assertEquals(1, callbacks.get());
        assertEquals(1, service.snapshot(9).revision());
        assertEquals("X\n", text(service.snapshot(9).content()));
    }

    @Test
    void 三十个客户端同基线并发提交均应收敛() throws Exception {
        DocRevService service = new DocRevService();
        CountDownLatch start = new CountDownLatch(1);
        try (var pool = Executors.newVirtualThreadPerTaskExecutor()) {
            List<Future<Long>> futures = java.util.stream.IntStream.range(0, 30)
                    .mapToObj(index -> pool.submit(() -> {
                        start.await();
                        return service.commit(12, 0,
                                new Delta().insert(String.valueOf((char) ('!' + index)))).revision();
                    }))
                    .toList();
            start.countDown();
            for (Future<Long> future : futures) {
                future.get();
            }
        }

        DocRevService.Snapshot snapshot = service.snapshot(12);
        String content = text(snapshot.content());
        assertEquals(30, snapshot.revision());
        assertEquals(31, content.length());
        for (int index = 0; index < 30; index++) {
            org.junit.jupiter.api.Assertions.assertTrue(content.contains(
                    String.valueOf((char) ('!' + index))));
        }
    }

    private static String text(Delta delta) {
        return delta.getOps().stream()
                .filter(Op::isTextInsert)
                .map(Op::text)
                .reduce("", String::concat);
    }
}
