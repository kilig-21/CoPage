package com.school.collab.collab.service;

import com.school.collab.collab.CollabException;
import com.school.collab.collab.persist.DocumentPersistence;
import com.school.collab.collab.persist.DocPersistenceQueue;
import com.school.collab.collab.persist.OperationFingerprint;
import com.school.collab.collab.store.CollabDocumentSnapshot;
import com.school.collab.collab.store.DocumentStateStore;
import com.school.collab.collab.store.DocumentStateStore.CorruptCacheException;
import com.school.collab.collab.store.InMemoryDocumentStateStore;
import com.school.collab.collab.store.VersionedOperation;
import com.school.collab.ot.Delta;
import com.school.collab.ot.DeltaApply;
import com.school.collab.ot.DeltaDiff;
import com.school.collab.ot.DeltaTransform;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.function.Consumer;
import java.util.function.Function;
import java.util.function.Supplier;

/**
 * 单实例文档版本服务。
 *
 * <p>生产环境热状态由 Redis 保存；无参构造只为纯单元测试提供内存实现。</p>
 */
@Service
public class DocRevService {

    private static final Logger log = LoggerFactory.getLogger(DocRevService.class);
    private static final int HISTORY_LIMIT = 2_000;
    private static final int REBASE_MAX_OPERATIONS = 10_000;
    private static final long REBASE_MAX_BYTES = 16 * 1024 * 1024;
    private static final int REBASE_PAGE_SIZE = 32;
    private static final int HISTORY_PAGE_SIZE = 256;
    private static final int LEGACY_PAGE_SIZE = 4;

    private final DocumentStateStore store;
    private final DocumentPersistence persistence;
    private final DocPersistenceQueue queue;
    /** 仅供无 MySQL 的纯单元测试实现去重；生产环境以持久化收据为准。 */
    private final ConcurrentMap<OperationKey, DocumentPersistence.Receipt> inMemoryReceipts =
            new ConcurrentHashMap<>();

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

    public long currentRevision(long docId) {
        validateDocId(docId);
        return persistence == null ? store.snapshot(docId).revision() : persistence.currentRevision(docId);
    }

    /** 追赶边界与本机订阅注册共用文档锁。调用方在返回后发送报文。 */
    public JoinState joinState(long docId, long lastRevision, long userId, String clientId,
                               PendingOperation pending, Consumer<JoinState> registerLocally) {
        validateDocId(docId);
        if (lastRevision < 0) {
            throw new CollabException(400, "lastRevision 不能小于 0");
        }
        return store.withDocumentLock(docId, () -> {
            CollabDocumentSnapshot snapshot = persistence == null
                    ? store.snapshot(docId) : reconcileLegacy(docId);
            Long committedRevision = pendingReceipt(docId, userId, clientId, pending, snapshot.revision());
            boolean complete = lastRevision <= snapshot.revision()
                    && snapshot.revision() - lastRevision <= HISTORY_LIMIT;
            long minimum = persistence == null ? store.minimumAvailableBaseRevision(docId) : persistence.minimumRevision(docId);
            complete = complete && lastRevision >= minimum;
            boolean paged = persistence != null && lastRevision >= minimum && lastRevision <= snapshot.revision()
                    && snapshot.revision() - lastRevision > HISTORY_LIMIT;
            List<VersionedOperation> history = List.of();
            if (complete && lastRevision < snapshot.revision()) {
                var batch = persistence == null ? null
                        : persistence.operationsBatch(docId, lastRevision, snapshot.revision(), HISTORY_PAGE_SIZE);
                history = persistence == null
                        ? store.operationsAfter(docId, lastRevision).stream()
                            .filter(entry -> entry.revision() <= snapshot.revision()).toList()
                        : batch.operations();
                long expected = lastRevision;
                for (VersionedOperation entry : history) {
                    if (entry.revision() != ++expected) {
                        complete = false;
                        break;
                    }
                }
                paged = batch != null && complete && expected > lastRevision
                        && (expected < snapshot.revision() || !batch.fitsInlineHistory());
                complete = complete && expected == snapshot.revision() && !paged;
            }
            if (!complete) {
                history = List.of();
            }
            var state = new JoinState(snapshot.revision(), snapshot.content(), complete, history, committedRevision, paged);
            registerLocally.accept(state);
            return state;
        });
    }

    private Long pendingReceipt(long docId, long userId, String clientId, PendingOperation pending, long through) {
        if (pending == null) return null;
        if (pending.baseRevision() < 0 || pending.operation() == null || pending.operation().getOps().isEmpty()) {
            throw new CollabException(400, "待确认操作不完整");
        }
        DocumentPersistence.Receipt receipt = persistence == null
                ? inMemoryReceipts.get(new OperationKey(docId, userId, clientId, pending.opId()))
                : persistence.receipt(docId, userId, clientId, pending.opId());
        if (receipt == null) return null;
        if (!OperationFingerprint.of(pending.baseRevision(), pending.operation()).equals(receipt.requestHash())) {
            throw new CollabException(40904, "opId 已用于其他操作，保留本地编辑并停止重放");
        }
        return receipt.revision() <= through ? receipt.revision() : null;
    }

    /** 固定 throughRevision，每页有界读取；前后页之间可提交新版本但不会改变追赶边界。 */
    public HistoryPage historyPage(long docId, long after, long through) {
        return historyPage(docId, after, through, 0, null, null);
    }

    public HistoryPage historyPage(long docId, long after, long through, long userId, String clientId, PendingOperation pending) {
        if (after < 0 || through < after) throw new CollabException(400, "追赶版本范围无效");
        return inspect(docId, current -> {
            if (through > current.revision()) throw new CollabException(40902, "追赶版本超前");
            long minimum = persistence == null ? store.minimumAvailableBaseRevision(docId) : persistence.minimumRevision(docId);
            if (after < minimum) throw new CollabException(40903, "历史已超出保留范围，本地内容仍应保留");
            List<VersionedOperation> history = persistence == null
                    ? store.operationsAfter(docId, after).stream().filter(op -> op.revision() <= through).limit(HISTORY_PAGE_SIZE).toList()
                    : persistence.operationsPage(docId, after, through, HISTORY_PAGE_SIZE);
            long expected = after;
            for (var op : history) if (op.revision() != ++expected) throw new CollabException(40903, "追赶历史有缺口");
            if (after < through && history.isEmpty()) throw new CollabException(40903, "追赶历史缺失");
            return new HistoryPage(after, expected, through, history, pendingReceipt(docId, userId, clientId, pending, through));
        });
    }

    /**
     * 服务端是唯一全序来源。晚到操作会逐条跨过 baseRevision 之后的历史操作。
     */
    public CommitResult commit(long docId, long baseRevision, Delta operation) {
        return commit(docId, baseRevision, operation, null, ignored -> {});
    }

    /**
     * 通知在文档锁释放后执行。接收方按持久化 revision 追赶乱序或遗漏的广播。
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
        return commit(docId, baseRevision, operation, userId, null, null, afterCommit);
    }

    public CommitResult commit(
            long docId, long baseRevision, Delta operation, Long userId,
            String clientId, String opId, Consumer<CommitResult> afterCommit
    ) {
        if (baseRevision < 0) {
            throw new CollabException(400, "baseRevision 不能小于 0");
        }
        if (opId != null && (userId == null || clientId == null || clientId.isBlank())) {
            throw new CollabException(400, "opId 需要有效的用户和 clientId");
        }
        if (operation == null || operation.getOps().isEmpty()) {
            throw new CollabException(400, "操作不能为空");
        }

        validateDocId(docId);
        String requestHash = opId == null ? null : OperationFingerprint.of(baseRevision, operation);
        var committed = store.withDocumentLock(docId, () -> commitLocked(docId, baseRevision,
                ignored -> operation, userId, clientId, opId, requestHash, false));
        return notifyCommitted(docId, committed, afterCommit);
    }

    /** 历史恢复也是新操作；版本变化时拒绝覆盖，重复请求只返回原收据。 */
    public CommitResult restore(long docId, long expectedRevision, long targetRevision,
                                long userId, String requestId, Supplier<Delta> target,
                                Consumer<CommitResult> afterCommit) {
        validateDocId(docId);
        if (expectedRevision < 0 || targetRevision < 0 || requestId == null
                || requestId.isBlank() || requestId.length() > 128) {
            throw new CollabException(400, "恢复请求不完整");
        }
        String hash = OperationFingerprint.of(expectedRevision,
                new Delta().insert("restore:" + targetRevision));
        var committed = store.withDocumentLock(docId, () -> commitLocked(docId, expectedRevision,
                current -> {
                    try {
                        Delta restored = target.get();
                        Delta operation = DeltaDiff.diff(current.content(), restored);
                        // Fragmented diffs can exceed the existing operation
                        // limit even when the restored document fits. Reject
                        // before applying or reserving the request receipt.
                        if (persistence != null) persistence.validateSize(restored, operation);
                        return operation;
                    } catch (DeltaDiff.ComplexityLimitException | DeltaDiff.TerminalNewlineAttributeException
                             | DeltaDiff.OperationSizeLimitException failure) {
                        throw new CollabException(400, failure.getMessage());
                    }
                }, userId, "history-api", requestId, hash, true));
        return notifyCommitted(docId, committed, afterCommit);
    }

    /** 读历史、分页追赶和维护共用提交锁，避免读取或清理跨过一次提交。 */
    public <T> T inspect(long docId, Function<Snapshot, T> action) {
        validateDocId(docId);
        return store.withDocumentLock(docId, () -> {
            var current = persistence == null ? store.snapshot(docId) : reconcileLegacy(docId);
            return action.apply(new Snapshot(docId, current.revision(), current.content()));
        });
    }

    public <T> T maintenanceLock(long docId, Supplier<T> action) {
        validateDocId(docId);
        return store.withDocumentLock(docId, action);
    }

    private CommitResult commitLocked(long docId, long baseRevision,
            Function<CollabDocumentSnapshot, Delta> operationFactory, Long userId,
            String clientId, String opId, String requestHash, boolean strict) {
            OperationKey key = opId == null ? null : new OperationKey(docId, userId, clientId, opId);
            if (key != null) {
                DocumentPersistence.Receipt prior = persistence == null
                        ? inMemoryReceipts.get(key)
                        : persistence.receipt(docId, userId, clientId, opId);
                if (prior != null) {
                    if (!requestHash.equals(prior.requestHash())) {
                        throw new CollabException(40904, "opId 已用于其他操作，请重新同步文档");
                    }
                    // 仅补发原 ack；正文、广播及 MQ 事件均不得再次执行。
                    return new CommitResult(prior.revision(), null, false);
                }
            }
            CollabDocumentSnapshot current = persistence == null
                    ? store.snapshot(docId) : reconcileLegacy(docId);
            if (strict && baseRevision != current.revision()) {
                throw new CollabException(40902, "文档已被继续编辑，请查看最新版本后再恢复");
            }
            if (baseRevision > current.revision()) {
                throw new CollabException(40902, "客户端版本超前");
            }
            if (persistence != null && baseRevision < persistence.minimumRevision(docId)) {
                throw new CollabException(40903, "操作基线超出保留范围，拒绝重放过期操作");
            }
            if (current.revision() - baseRevision > REBASE_MAX_OPERATIONS) {
                throw rebaseLimit();
            }
            Delta transformed = rebase(docId, baseRevision, current.revision(), operationFactory.apply(current).copy());

            long revision = current.revision() + 1;
            Delta nextContent = DeltaApply.apply(current.content(), transformed);
            // 在OT变换后的最终正文上检查，不能只看原请求；拒绝时尚未写入日志或收据。
            if (nextContent.getOps().isEmpty() || !nextContent.getOps().getLast().isTextInsert()
                    || !nextContent.getOps().getLast().text().endsWith("\n")) {
                throw new CollabException(400, "文档正文必须保留末尾换行");
            }
            if (persistence != null) {
                if (key == null) {
                    persistence.persist(docId, current.revision(), nextContent, transformed, userId);
                } else {
                    persistence.persist(docId, current.revision(), nextContent, transformed,
                            userId, clientId, opId, requestHash);
                }
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
            if (key != null && persistence == null) {
                inMemoryReceipts.put(key, new DocumentPersistence.Receipt(revision, requestHash));
            }
            return new CommitResult(revision, transformed.copy());
    }

    private CommitResult notifyCommitted(long docId, CommitResult result, Consumer<CommitResult> afterCommit) {
        if (!result.applied()) return result;
        if (queue != null) {
            try {
                queue.publishCommitted(docId, result.revision());
            } catch (RuntimeException exception) {
                log.warn("操作已持久化但 RabbitMQ 通知失败, docId={}, revision={}", docId, result.revision(), exception);
            }
        }
        afterCommit.accept(result);
        return result;
    }

    private Delta rebase(long docId, long after, long through, Delta transformed) {
        long totalBytes = 0;
        while (after < through) {
            List<VersionedOperation> page;
            if (persistence == null) {
                page = store.operationsAfter(docId, after);
            } else {
                var batch = persistence.operationsBatch(docId, after, through, REBASE_PAGE_SIZE);
                totalBytes += batch.bytes();
                if (totalBytes > REBASE_MAX_BYTES) throw rebaseLimit();
                page = batch.operations();
            }
            if (page.isEmpty()) throw historyGap();
            for (VersionedOperation entry : page) {
                if (entry.revision() != after + 1 || entry.revision() > through) throw historyGap();
                // 已提交历史优先；新到的操作转换到历史已执行后的坐标系。
                transformed = DeltaTransform.transform(entry.operation(), transformed, true);
                after = entry.revision();
            }
        }
        return transformed;
    }

    private static CollabException historyGap() {
        return new CollabException(40903, "版本历史不完整，请重新同步文档");
    }

    private static CollabException rebaseLimit() {
        return new CollabException(40903, "待变换的历史超出安全范围，请重新同步文档，未确认内容仍可保留");
    }

    /** 只有能完整重建且与热正文一致的旧链才写入 MySQL。 */
    private CollabDocumentSnapshot reconcileLegacy(long docId) {
        CollabDocumentSnapshot durable = persistence.snapshot(docId);
        List<VersionedOperation> missing;
        try {
            var hot = store.snapshot(docId);
            if (hot.revision() <= durable.revision()) {
                if (hot.revision() == durable.revision() && hot.revision() > 0 &&
                        !hot.content().getOps().equals(durable.content().getOps())) {
                    throw new CorruptCacheException("相同版本正文不一致");
                }
                expireDurableLegacyState(docId, hot.revision());
                return durable;
            }
            missing = legacyChain(docId, durable, hot);
        } catch (CorruptCacheException failure) {
            quarantineLegacy(docId, durable, failure.getMessage());
            return durable;
        } catch (RuntimeException unavailable) {
            log.warn("Redis 热状态读取失败，暂用 MySQL, docId={}, revision={}, reason={}",
                    docId, durable.revision(), unavailable.getClass().getSimpleName());
            return durable;
        }

        long revision = durable.revision();
        Delta content = durable.content();
        for (VersionedOperation entry : missing) {
            content = DeltaApply.apply(content, entry.operation());
            persistence.persist(docId, revision, content, entry.operation(), null);
            revision++;
        }
        expireDurableLegacyState(docId, revision);
        return new CollabDocumentSnapshot(revision, content);
    }

    private List<VersionedOperation> legacyChain(long docId, CollabDocumentSnapshot durable, CollabDocumentSnapshot hot) {
        if (hot.revision() - durable.revision() > HISTORY_LIMIT) throw new CorruptCacheException("旧历史超出保留窗口");
        var missing = new ArrayList<VersionedOperation>();
        long revision = durable.revision();
        long bytes = 0;
        Delta content = durable.content();
        while (revision < hot.revision()) {
            var batch = store.legacyOperationsAfter(docId, revision, LEGACY_PAGE_SIZE);
            bytes += batch.bytes();
            if (bytes > REBASE_MAX_BYTES || batch.operations().isEmpty()) throw new CorruptCacheException("旧历史不完整或超限");
            for (var entry : batch.operations()) {
                if (entry.revision() != revision + 1 || entry.revision() > hot.revision()) {
                    throw new CorruptCacheException("旧历史有版本缺口");
                }
                try {
                    content = DeltaApply.apply(content, entry.operation());
                    persistence.validateSize(content, entry.operation());
                } catch (RuntimeException invalidOperation) {
                    throw new CorruptCacheException("旧操作无法安全应用");
                }
                missing.add(entry);
                revision++;
            }
        }
        if (!content.getOps().equals(hot.content().getOps())) throw new CorruptCacheException("旧历史无法重建热正文");
        return missing;
    }

    private void quarantineLegacy(long docId, CollabDocumentSnapshot durable, String reason) {
        try {
            String archive = store.quarantineAndReset(docId, durable);
            log.warn("Redis 热状态降级至 MySQL, docId={}, revision={}, reason={}, archive={}",
                    docId, durable.revision(), reason, archive);
        } catch (RuntimeException unavailable) {
            log.warn("Redis 热状态暂未重建，继续使用 MySQL, docId={}, revision={}, reason={}",
                    docId, durable.revision(), unavailable.getClass().getSimpleName());
        }
    }

    private void expireDurableLegacyState(long docId, long revision) {
        try {
            store.expireDurableLegacyState(docId, revision);
        } catch (RuntimeException failure) {
            // A failed TTL update cannot invalidate a MySQL-persisted revision.
            log.debug("未能更新旧热状态 TTL, docId={}", docId, failure);
        }
    }
    private static void validateDocId(long docId) {
        if (docId <= 0) {
            throw new CollabException(400, "docId 必须大于 0");
        }
    }

    public record Snapshot(long docId, long revision, Delta content) {
    }

    public record PendingOperation(String opId, long baseRevision, Delta operation) {
    }

    public record JoinState(long revision, Delta content, boolean historyComplete,
                            List<VersionedOperation> history, Long pendingCommittedRevision, boolean historyPaged) {
        public JoinState(long revision, Delta content, boolean historyComplete,
                         List<VersionedOperation> history, Long pendingCommittedRevision) {
            this(revision, content, historyComplete, history, pendingCommittedRevision, false);
        }
    }

    public record HistoryPage(long fromRevision, long toRevision, long revision,
                              List<VersionedOperation> history, Long pendingCommittedRevision) { }

    public record CommitResult(long revision, Delta operation, boolean applied) {
        public CommitResult(long revision, Delta operation) {
            this(revision, operation, true);
        }
    }

    private record OperationKey(long docId, long userId, String clientId, String opId) {
    }

}
