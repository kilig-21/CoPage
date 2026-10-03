package com.school.collab.document;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.collab.service.DocRevService;
import com.school.collab.collab.store.CollabDocumentSnapshot;
import com.school.collab.collab.ws.CollabEventBus;
import com.school.collab.common.BizException;
import com.school.collab.common.ErrorCode;
import com.school.collab.common.UserContext;
import com.school.collab.ot.Delta;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.List;

@Service
public class HistoryService {
    private static final Logger log = LoggerFactory.getLogger(HistoryService.class);
    private final HistoryRepository history;
    private final DocumentRepository documents;
    private final DocumentService permissions;
    private final DocRevService revisions;
    private final CollabEventBus events;
    private final ObjectMapper mapper;
    private final HistoryMaintenance maintenance;

    public HistoryService(HistoryRepository history, DocumentRepository documents, DocumentService permissions,
                          DocRevService revisions, CollabEventBus events, ObjectMapper mapper, HistoryMaintenance maintenance) {
        this.history = history; this.documents = documents; this.permissions = permissions;
        this.revisions = revisions; this.events = events; this.mapper = mapper;
        this.maintenance = maintenance;
    }

    public HistoryView list(long docId, long before, int limit) {
        long user = user();
        permissions.permissionFor(docId, user);
        if (before < 1 || limit < 1 || limit > 100) throw new BizException(ErrorCode.PARAM_ERROR);
        return revisions.inspect(docId, current -> {
            permissions.permissionFor(docId, user);
            var versions = history.versions(docId, before, limit);
            Long next = versions.size() == limit ? versions.getLast().revision() : null;
            return new HistoryView(current.revision(), history.floor(docId), versions, history.namedVersions(docId), next);
        });
    }

    public ContentView content(long docId, long revision) {
        long user = user();
        permissions.permissionFor(docId, user);
        return revisions.inspect(docId, current -> {
            Delta content = at(docId, revision, current);
            permissions.permissionFor(docId, user);
            return new ContentView(revision, content);
        });
    }

    public void name(long docId, long revision, String name) {
        long user = owner(docId);
        String normalized = name == null ? "" : name.trim();
        if (normalized.isEmpty() || normalized.length() > 100) throw new BizException(ErrorCode.PARAM_ERROR);
        revisions.inspect(docId, current -> {
            owner(docId);
            history.name(docId, revision, normalized, user, at(docId, revision, current));
            return null;
        });
    }

    public void unname(long docId, long revision) {
        owner(docId);
        if (revision < 0) throw new BizException(ErrorCode.PARAM_ERROR);
        revisions.inspect(docId, current -> { owner(docId); history.unname(docId, revision); return null; });
    }

    public RestoreView restore(long docId, long revision, long expectedRevision, String requestId) {
        long user = owner(docId);
        var result = revisions.restore(docId, expectedRevision, revision, user, requestId, () -> {
            owner(docId);
            // restore 的 supplier 已在提交锁内，禁止再次申请同一把 Redis 锁。
            var row = documents.find(docId).orElseThrow(() -> new BizException(ErrorCode.NOT_FOUND));
            try {
                return history.contentAt(docId, revision,
                        new CollabDocumentSnapshot(row.revision(), mapper.readValue(row.content(), Delta.class)));
            } catch (com.fasterxml.jackson.core.JsonProcessingException ex) {
                throw new IllegalStateException("文档正文损坏", ex);
            }
        }, committed -> {
            var op = mapper.createObjectNode().put("type", "op").put("docId", docId)
                    .put("originClientId", "history-api").put("opId", requestId).put("revision", committed.revision());
            op.set("op", mapper.valueToTree(committed.operation()));
            try { events.publish(docId, "", op); }
            catch (RuntimeException ex) { log.warn("历史已恢复但广播暂时失败，客户端将由心跳追赶, docId={}", docId); }
        });
        return new RestoreView(result.revision(), result.applied());
    }

    private Delta at(long docId, long revision, DocRevService.Snapshot current) {
        return history.contentAt(docId, revision, new CollabDocumentSnapshot(current.revision(), current.content()));
    }

    public HistoryMaintenance.RetentionView retention(long docId) {
        owner(docId);
        return maintenance.preview(docId);
    }

    public long compact(long docId, long expectedRevision, long beforeRevision) {
        owner(docId);
        if (maintenance.isProtected(docId)) throw new BizException(ErrorCode.FORBIDDEN, "该文档已排除在历史清理范围外");
        return revisions.inspect(docId, current -> {
            owner(docId);
            if (current.revision() != expectedRevision) throw new com.school.collab.collab.CollabException(40902, "文档已有新编辑，请重新预览清理范围");
            if (beforeRevision <= history.floor(docId) || beforeRevision > current.revision()) throw new BizException(ErrorCode.PARAM_ERROR);
            history.compact(docId, beforeRevision, at(docId, beforeRevision, current));
            return beforeRevision;
        });
    }

    private long owner(long docId) {
        long user = user();
        permissions.permissionFor(docId, user);
        if (documents.find(docId).orElseThrow(() -> new BizException(ErrorCode.NOT_FOUND)).ownerId() != user) {
            throw new BizException(ErrorCode.FORBIDDEN, "只有所有者能恢复或标记历史版本");
        }
        return user;
    }

    private long user() {
        Long id = UserContext.getUserId();
        if (id == null) throw new BizException(ErrorCode.UNAUTHORIZED);
        return id;
    }

    public record HistoryView(long currentRevision, long minimumRevision, List<HistoryRepository.VersionView> list,
                              List<HistoryRepository.VersionView> namedVersions, Long nextBeforeRevision) { }
    public record ContentView(long revision, Delta content) { }
    public record RestoreView(long revision, boolean applied) { }
}
