package com.school.collab.collab.service;

import com.school.collab.collab.CollabException;
import com.school.collab.collab.persist.DocumentPersistence;
import com.school.collab.collab.persist.DocPersistenceQueue;
import com.school.collab.collab.store.CollabDocumentSnapshot;
import com.school.collab.collab.store.DocumentStateStore;
import com.school.collab.collab.store.InMemoryDocumentStateStore;
import com.school.collab.collab.store.VersionedOperation;
import com.school.collab.ot.Delta;
import com.school.collab.ot.DeltaApply;
import com.school.collab.ot.DeltaTransform;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.util.function.Consumer;

/**
 * 单实例文档版本服务。
 *
 * <p>生产环境热状态由 Redis 保存；无参构造只为纯单元测试提供内存实现。</p>
 */
@Service
public class DocRevService {

    private static final Logger log = LoggerFactory.getLogger(DocRevService.class);
    private static final int HISTORY_LIMIT = 2_000;

    private final DocumentStateStore store;
    private final DocumentPersistence persistence;
    private final DocPersistenceQueue queue;

    public DocRevService() {
        this(new InMemoryDocumentStateStore(), null, null);
    }

    public DocRevService(DocumentStateStore store, DocumentPersistence persistence) {
        this(store, persistence, null);
    }

    @Autowired
    public DocRevService(DocumentStateStore store, DocumentPersistence persistence,
                         DocPersistenceQueue queue) {
        this.store = store;
        this.persistence = persistence;
        this.queue = queue;
    }

    public Snapshot snapshot(long docId) {
        validateDocId(docId);
        CollabDocumentSnapshot snapshot = persistence == null
                ? store.snapshot(docId)
                : store.withDocumentLock(docId, () -> reconcileLegacy(docId));
        return new Snapshot(docId, snapshot.revision(), snapshot.content());
    }

    /**
     * 服务端是唯一全序来源。晚到操作会逐条跨过 baseRevision 之后的历史操作。
     */
    public CommitResult commit(long docId, long baseRevision, Delta operation) {
        return commit(docId, baseRevision, operation, null, ignored -> {});
    }

    /**
     * afterCommit 在文档锁释放前执行，供跨实例广播保证发布顺序与 revision 顺序一致。
     */
    public CommitResult commit(
            long docId, long baseRevision, Delta operation, Consumer<CommitResult> afterCommit
    ) {
        return commit(docId, baseRevision, operation, null, afterCommit);
    }

    public CommitResult commit(
            long docId, long baseRevision, Delta operation, Long userId,
            Consumer<CommitResult> afterCommit
    ) {
        if (baseRevision < 0) {
            throw new CollabException(400, "baseRevision 不能小于 0");
        }
        if (operation == null || operation.getOps().isEmpty()) {
            throw new CollabException(400, "操作不能为空");
        }

        validateDocId(docId);
        return store.withDocumentLock(docId, () -> {
            CollabDocumentSnapshot current = persistence == null
                    ? store.snapshot(docId) : reconcileLegacy(docId);
            if (baseRevision > current.revision()) {
                throw new CollabException(40902, "客户端版本超前");
            }
            Delta transformed = operation.copy();
            var history = persistence == null
                    ? store.operationsAfter(docId, baseRevision)
                    : persistence.operationsAfter(docId, baseRevision);
            if (baseRevision < current.revision()
                    && (history.isEmpty() || history.getFirst().revision() != baseRevision + 1)) {
                throw new CollabException(40903, "版本历史不完整，请重新同步文档");
            }
            long expectedRevision = baseRevision + 1;
            for (VersionedOperation entry : history) {
                if (entry.revision() != expectedRevision++) {
                    throw new CollabException(40903, "版本历史不完整，请重新同步文档");
                }
                // 已提交历史优先；新到的操作转换到历史已执行后的坐标系。
                transformed = DeltaTransform.transform(entry.operation(), transformed, true);
            }

            long revision = current.revision() + 1;
            Delta nextContent = DeltaApply.apply(current.content(), transformed);
            if (persistence != null) {
                persistence.persist(docId, current.revision(), nextContent, transformed, userId);
            }
            try {
                store.save(
                        docId,
                        new CollabDocumentSnapshot(revision, nextContent),
                        new VersionedOperation(revision, transformed),
                        HISTORY_LIMIT
                );
            } catch (RuntimeException exception) {
                if (persistence == null) {
                    throw exception;
                }
                // MySQL 已提交；Redis 只是缓存，不能让客户端误以为操作失败后重放。
                log.warn("MySQL 已持久化但 Redis 热状态更新失败, docId={}, revision={}",
                        docId, revision, exception);
            }
            CommitResult result = new CommitResult(revision, transformed.copy());
            afterCommit.accept(result);
            if (queue != null) {
                try {
                    queue.publishCommitted(docId, revision);
                } catch (RuntimeException exception) {
                    // 操作已在 MySQL 提交；巡检会补快照，不能要求客户端重发。
                    log.warn("操作已持久化但 RabbitMQ 通知失败, docId={}, revision={}",
                            docId, revision, exception);
                }
            }
            return result;
        });
    }

    /** 升级前仅写 Redis 的文档逐条补进 MySQL；缺失历史时绝不静默覆盖。 */
    private CollabDocumentSnapshot reconcileLegacy(long docId) {
        CollabDocumentSnapshot durable = persistence.snapshot(docId);
        CollabDocumentSnapshot hot = store.snapshot(docId);
        if (hot.revision() <= durable.revision()) {
            return durable;
        }
        var missing = store.operationsAfter(docId, durable.revision());
        long expected = durable.revision() + 1;
        for (VersionedOperation entry : missing) {
            if (entry.revision() != expected++) {
                throw new IllegalStateException("Redis 文档历史有缺口，拒绝覆盖未持久化内容: docId=" + docId);
            }
        }
        if (expected - 1 != hot.revision()) {
            throw new IllegalStateException("Redis 文档历史不完整，拒绝覆盖未持久化内容: docId=" + docId);
        }
        long revision = durable.revision();
        Delta content = durable.content();
        for (VersionedOperation entry : missing) {
            content = DeltaApply.apply(content, entry.operation());
            persistence.persist(docId, revision, content, entry.operation(), null);
            revision++;
        }
        return new CollabDocumentSnapshot(revision, content);
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
