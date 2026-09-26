package com.school.collab.collab.store;

import java.util.List;
import java.util.function.Supplier;

/**
 * 协同热状态的存储抽象。
 *
 * <p>生产环境由 Redis 实现，单元测试保留内存实现；DocRevService 不依赖具体介质。</p>
 */
public interface DocumentStateStore {

    CollabDocumentSnapshot snapshot(long docId);

    /** 客户端可接受的最小 baseRevision；更低代表所需历史已经被裁剪。 */
    long minimumAvailableBaseRevision(long docId);

    List<VersionedOperation> operationsAfter(long docId, long revision);

    void save(long docId, CollabDocumentSnapshot snapshot, VersionedOperation operation, int historyLimit);

    <T> T withDocumentLock(long docId, Supplier<T> action);
}
