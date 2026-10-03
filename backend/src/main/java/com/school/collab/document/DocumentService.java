package com.school.collab.document;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.common.BizException;
import com.school.collab.common.ErrorCode;
import com.school.collab.common.UserContext;
import com.school.collab.document.DocumentRepository.DocumentRow;
import com.school.collab.search.SearchIndex;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.time.format.DateTimeFormatter;
import java.util.List;

@Service
public class DocumentService {
    private static final Logger log = LoggerFactory.getLogger(DocumentService.class);
    private static final String EMPTY_CONTENT = "{\"ops\":[{\"insert\":\"\\n\"}]}";
    private static final DateTimeFormatter TIME_FORMAT = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");

    private final DocumentRepository documents;
    private final ObjectMapper objectMapper;
    private final SearchIndex searchIndex;
    private final org.springframework.context.ApplicationEventPublisher lifecycle;

    public DocumentService(DocumentRepository documents, ObjectMapper objectMapper) {
        this(documents, objectMapper, null);
    }

    public DocumentService(DocumentRepository documents, ObjectMapper objectMapper, SearchIndex searchIndex) {
        this(documents, objectMapper, searchIndex, null);
    }

    @Autowired
    public DocumentService(DocumentRepository documents, ObjectMapper objectMapper, SearchIndex searchIndex,
                           org.springframework.context.ApplicationEventPublisher lifecycle) {
        this.documents = documents;
        this.objectMapper = objectMapper;
        this.searchIndex = searchIndex;
        this.lifecycle = lifecycle;
    }

    public ListView list(int page, int size, String keyword) {
        if (page < 1 || size < 1 || size > 100) {
            throw new BizException(ErrorCode.PARAM_ERROR);
        }
        long userId = currentUserId();
        String filter = keyword == null ? "" : keyword.trim();
        long total = documents.countVisible(userId, filter);
        List<SummaryView> list = documents.listVisible(userId, filter, page, size)
                .stream().map(this::summary).toList();
        return new ListView(total, list);
    }

    @Transactional
    public SummaryView create(String title, long parentId) {
        return create(title, parentId, null);
    }

    @Transactional
    public SummaryView create(String title, long parentId, String templateId) {
        if (parentId < 0) {
            throw new BizException(ErrorCode.PARAM_ERROR);
        }
        long userId = currentUserId();
        if (parentId > 0) {
            DocumentRow parent = requireVisible(parentId, userId);
            if (parent.ownerId() != userId) {
                throw new BizException(ErrorCode.FORBIDDEN);
            }
        }
        var template = templateId == null ? null : DocumentTemplates.require(templateId);
        String normalizedTitle = normalizeTitle(title == null && template != null ? template.title() : title, true);
        String content = EMPTY_CONTENT;
        if (template != null) {
            try { content = objectMapper.writeValueAsString(template.content()); }
            catch (JsonProcessingException ex) { throw new IllegalStateException("模板内容无法序列化", ex); }
        }
        long id = documents.create(normalizedTitle, userId, parentId, content);
        if (template != null) documents.saveInitialSnapshot(id, content);
        indexAfterCommit(id);
        DocumentRow row = documents.find(id).orElseThrow(() -> new BizException(ErrorCode.INTERNAL_ERROR));
        return summary(row);
    }

    public DetailView detail(long docId) {
        long userId = currentUserId();
        DocumentRow row = requireVisible(docId, userId);
        int permission = permission(row, userId);
        return new DetailView(
                row.id(), row.title(), parseContent(row.content()), row.revision(),
                row.ownerId(), permission, format(row.updateTime()), row.ownerId() == userId);
    }

    @Transactional
    public RenameView rename(long docId, String title) {
        long userId = currentUserId();
        DocumentRow row = requireVisible(docId, userId);
        if (permission(row, userId) != 2) {
            throw new BizException(ErrorCode.FORBIDDEN);
        }
        if (!documents.rename(docId, normalizeTitle(title, false))) {
            throw new BizException(ErrorCode.NOT_FOUND);
        }
        indexAfterCommit(docId);
        DocumentRow updated = documents.find(docId).orElseThrow(() -> new BizException(ErrorCode.NOT_FOUND));
        return new RenameView(updated.id(), updated.title(), format(updated.updateTime()));
    }

    @Transactional
    public void delete(long docId) {
        long userId = currentUserId();
        DocumentRow row = requireVisible(docId, userId);
        if (row.ownerId() != userId) {
            throw new BizException(ErrorCode.FORBIDDEN);
        }
        if (!documents.softDelete(docId)) {
            throw new BizException(ErrorCode.NOT_FOUND);
        }
        indexAfterCommit(docId);
        if (lifecycle != null) lifecycle.publishEvent(new DocumentDeleted(docId));
    }

    public TrashView trash(int page, int size) {
        if (page < 1 || size < 1 || size > 100) throw new BizException(ErrorCode.PARAM_ERROR);
        long userId = currentUserId();
        return new TrashView(documents.countDeletedOwned(userId), documents.listDeletedOwned(userId,page,size)
            .stream().map(row->new TrashItem(row.id(),row.title(),format(row.deletedAt()))).toList());
    }

    @Transactional
    public SummaryView restoreDeleted(long docId) {
        long userId = currentUserId();
        if (docId <= 0) throw new BizException(ErrorCode.PARAM_ERROR);
        var owned = documents.findOwnedForUpdate(docId,userId).orElseThrow(()->new BizException(ErrorCode.NOT_FOUND));
        if (owned.deleted()) {
            if (!documents.restoreDeleted(docId,userId)) throw new BizException(ErrorCode.NOT_FOUND);
            indexAfterCommit(docId);
        }
        return summary(documents.find(docId).orElseThrow(()->new BizException(ErrorCode.NOT_FOUND)));
    }

    public record TrashItem(long id,String title,String deletedAt) { }
    public record TrashView(long total,List<TrashItem> list) { }
    public record DocumentDeleted(long docId) { }

    public int permissionFor(long docId, long userId) {
        return permission(requireVisible(docId, userId), userId);
    }

    private DocumentRow requireVisible(long docId, long userId) {
        if (docId <= 0) {
            throw new BizException(ErrorCode.PARAM_ERROR);
        }
        DocumentRow row = documents.find(docId).orElseThrow(() -> new BizException(ErrorCode.NOT_FOUND));
        if (permission(row, userId) == 0) {
            throw new BizException(ErrorCode.FORBIDDEN);
        }
        return row;
    }

    private int permission(DocumentRow row, long userId) {
        return row.ownerId() == userId ? 2 : documents.collaboratorPermission(row.id(), userId);
    }

    private JsonNode parseContent(String content) {
        try {
            return objectMapper.readTree(content == null ? EMPTY_CONTENT : content);
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException("数据库中的文档内容不是合法 Delta", exception);
        }
    }

    private void indexAfterCommit(long docId) {
        if (searchIndex == null) return;
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                try {
                    searchIndex.upsert(docId);
                } catch (RuntimeException exception) {
                    // 文档事务已成功；周期重建会补索引，不能让客户端误重试创建/重命名。
                    log.warn("文档已提交但 ES 索引暂时失败, docId={}", docId, exception);
                }
            }
        });
    }

    private SummaryView summary(DocumentRow row) {
        return new SummaryView(row.id(), row.title(), row.ownerId(), row.ownerName(),
                row.parentId(), format(row.updateTime()), permission(row, currentUserId()),
                row.ownerId() == currentUserId());
    }

    private static long currentUserId() {
        Long userId = UserContext.getUserId();
        if (userId == null) {
            throw new BizException(ErrorCode.UNAUTHORIZED);
        }
        return userId;
    }

    private static String normalizeTitle(String title, boolean allowDefault) {
        String normalized = title == null ? "" : title.trim();
        if (normalized.isEmpty() && allowDefault) {
            return "未命名文档";
        }
        if (normalized.isEmpty() || normalized.length() > 200) {
            throw new BizException(ErrorCode.PARAM_ERROR);
        }
        return normalized;
    }

    private static String format(java.time.LocalDateTime time) {
        return time.format(TIME_FORMAT);
    }

    public record SummaryView(
            long id, String title, long ownerId, String ownerName, long parentId, String updateTime,
            int permission, boolean isOwner
    ) {
    }

    public record ListView(long total, List<SummaryView> list) {
    }

    public record DetailView(
            long id, String title, JsonNode content, long revision,
            long ownerId, int permission, String updateTime, boolean isOwner
    ) {
    }

    public record RenameView(long id, String title, String updateTime) {
    }
}
