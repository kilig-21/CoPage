package com.school.collab.collab.service;

import com.school.collab.collab.CollabException;
import com.school.collab.collab.store.CollabDocumentSnapshot;
import com.school.collab.collab.store.DocumentStateStore;
import com.school.collab.collab.store.InMemoryDocumentStateStore;
import com.school.collab.collab.store.VersionedOperation;
import com.school.collab.ot.Delta;
import com.school.collab.ot.DeltaApply;
import com.school.collab.ot.DeltaTransform;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;


/**
 * 单实例文档版本服务。
 *
 * <p>生产环境热状态由 Redis 保存；无参构造只为纯单元测试提供内存实现。</p>
 */
@Service
public class DocRevService {

    private static final int HISTORY_LIMIT = 2_000;

    private final DocumentStateStore store;

    public DocRevService() {
        this(new InMemoryDocumentStateStore());
    }

    @Autowired
    public DocRevService(DocumentStateStore store) {
        this.store = store;
    }

    public Snapshot snapshot(long docId) {
        validateDocId(docId);
        CollabDocumentSnapshot snapshot = store.snapshot(docId);
        return new Snapshot(docId, snapshot.revision(), snapshot.content());
    }

    /**
     * 服务端是唯一全序来源。晚到操作会逐条跨过 baseRevision 之后的历史操作。
     */
    public CommitResult commit(long docId, long baseRevision, Delta operation) {
        if (baseRevision < 0) {
            throw new CollabException(400, "baseRevision 不能小于 0");
        }
        if (operation == null || operation.getOps().isEmpty()) {
            throw new CollabException(400, "操作不能为空");
        }

        validateDocId(docId);
        return store.withDocumentLock(docId, () -> {
            CollabDocumentSnapshot current = store.snapshot(docId);
            if (baseRevision > current.revision()) {
                throw new CollabException(40902, "客户端版本超前");
            }
            if (baseRevision < store.minimumAvailableBaseRevision(docId)) {
                throw new CollabException(40903, "版本历史过旧，请重新同步文档");
            }

            Delta transformed = operation.copy();
            for (VersionedOperation history : store.operationsAfter(docId, baseRevision)) {
                // 已提交历史优先；新到的操作转换到历史已执行后的坐标系。
                transformed = DeltaTransform.transform(history.operation(), transformed, true);
            }

            long revision = current.revision() + 1;
            Delta nextContent = DeltaApply.apply(current.content(), transformed);
            store.save(
                    docId,
                    new CollabDocumentSnapshot(revision, nextContent),
                    new VersionedOperation(revision, transformed),
                    HISTORY_LIMIT
            );
            return new CommitResult(revision, transformed.copy());
        });
    }

    private static void validateDocId(long docId) {
        if (docId <= 0) {
            throw new CollabException(400, "docId 必须大于 0");
        }
    }

    public record Snapshot(long docId, long revision, Delta content) {
    }

    public record CommitResult(long revision, Delta operation) {
    }

}
