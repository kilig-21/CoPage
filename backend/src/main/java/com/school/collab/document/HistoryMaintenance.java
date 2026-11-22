package com.school.collab.document;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.collab.service.DocRevService;
import com.school.collab.collab.store.CollabDocumentSnapshot;
import com.school.collab.ot.DeltaJson;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import java.util.Set;
import java.util.Arrays;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.stream.Collectors;

@Component
public class HistoryMaintenance {
    private static final Logger log = LoggerFactory.getLogger(HistoryMaintenance.class);
    private final HistoryRepository history;
    private final DocRevService revisions;
    private final ObjectMapper mapper;
    private final boolean enabled;
    private final int days, maxOperations;
    private final int maxSnapshots;
    private final long maxBytes;
    private final Set<Long> protectedIds;
    private final AtomicBoolean running = new AtomicBoolean();
    private long cursor;

    public HistoryMaintenance(HistoryRepository history, DocRevService revisions, ObjectMapper mapper,
            @Value("${collab.history.retention-enabled:true}") boolean enabled,
            @Value("${collab.history.retention-days:30}") int days,
            @Value("${collab.history.max-operations:10000}") int maxOperations,
            @Value("${collab.history.max-snapshots:100}") int maxSnapshots,
            @Value("${collab.history.max-bytes:67108864}") long maxBytes,
            @Value("${collab.history.protected-doc-ids:26,536,548}") String protectedIds) {
        this.history = history; this.revisions = revisions; this.mapper = mapper;
        this.enabled = enabled; this.days = days; this.maxOperations = maxOperations; this.maxBytes = maxBytes;
        this.maxSnapshots = maxSnapshots;
        if (days < 1 || maxOperations < 2000 || maxSnapshots < 1 || maxBytes < 4L * 1024 * 1024) {
            throw new IllegalArgumentException("历史保留参数无效：至少 1 天、2000 操作、1 快照、4 MiB");
        }
        this.protectedIds = Arrays.stream(protectedIds.split(",")).map(String::trim).filter(s -> !s.isEmpty())
                .map(Long::parseLong).collect(Collectors.toUnmodifiableSet());
    }

    @Scheduled(initialDelay = 60000, fixedDelayString = "${collab.history.maintenance-interval-ms:3600000}")
    public void maintain() {
        if (!enabled || !running.compareAndSet(false, true)) return;
        try {
            maintainBatch();
        } finally {
            running.set(false);
        }
    }

    private void maintainBatch() {
        for(long id:history.expiredDeletedCandidates(days)) {
            if(protectedIds.contains(id)) continue;
            try { revisions.maintenanceLock(id,()->{history.compactDeleted(id,days);return null;}); }
            catch(RuntimeException ex) {log.warn("软删除文档历史压缩暂时失败, docId={}",id,ex);}
        }
        var ids = history.maintenanceCandidates(cursor, 50);
        if (ids.isEmpty()) { cursor = 0; return; }
        for (long id : ids) {
            cursor = id;
            if (protectedIds.contains(id)) continue;
            try {
                revisions.inspect(id, current -> {
                    // 先裁能从连续日志重建的快照，避免只因快照副本占用配额就推进历史起点。
                    int trimmed = history.trimPeriodicSnapshots(id, maxSnapshots);
                    int size = DeltaJson.utf8Bytes(mapper, current.content());
                    long floor = history.retentionFloor(id, current.revision(), days, maxOperations, maxBytes, size);
                    if (floor > history.floor(id)) {
                        var baseline = history.contentAt(id, floor, new CollabDocumentSnapshot(current.revision(), current.content()));
                        history.compact(id, floor, baseline);
                        log.info("历史压缩完成, docId={}, minimumRevision={}", id, floor);
                    }
                    if (trimmed > 0) log.info("周期快照裁剪完成, docId={}, removed={}", id, trimmed);
                    return null;
                });
            } catch (RuntimeException ex) { log.warn("历史维护暂时失败，下轮重试, docId={}", id, ex); }
        }
    }

    public boolean isProtected(long docId) { return protectedIds.contains(docId); }

    public RetentionView preview(long docId) {
        return revisions.inspect(docId, current -> {
            int bytes = DeltaJson.utf8Bytes(mapper, current.content());
            long minimum = history.floor(docId);
            long proposed = isProtected(docId) ? minimum
                    : history.retentionFloor(docId,current.revision(),days,maxOperations,maxBytes,bytes);
            return new RetentionView(enabled,days,maxOperations,maxSnapshots,maxBytes,isProtected(docId),current.revision(),minimum,proposed);
        });
    }
    public record RetentionView(boolean enabled,int days,int maxOperations,int maxSnapshots,long maxBytes,boolean protectedDocument,
                                long currentRevision,long minimumRevision,long proposedMinimumRevision) { }
}
