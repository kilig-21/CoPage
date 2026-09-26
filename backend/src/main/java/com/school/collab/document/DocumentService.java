package com.school.collab.document;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.common.BizException;
import com.school.collab.common.ErrorCode;
import com.school.collab.common.UserContext;
import com.school.collab.document.DocumentRepository.DocumentRow;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.format.DateTimeFormatter;
import java.util.List;

@Service
public class DocumentService {
    private static final String EMPTY_CONTENT = "{\"ops\":[{\"insert\":\"\\n\"}]}";
    private static final DateTimeFormatter TIME_FORMAT = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");

    private final DocumentRepository documents;
    private final ObjectMapper objectMapper;

    public DocumentService(DocumentRepository documents, ObjectMapper objectMapper) {
        this.documents = documents;
        this.objectMapper = objectMapper;
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
        String normalizedTitle = normalizeTitle(title, true);
        long id = documents.create(normalizedTitle, userId, parentId, EMPTY_CONTENT);
        DocumentRow row = documents.find(id).orElseThrow(() -> new BizException(ErrorCode.INTERNAL_ERROR));
        return summary(row);
    }

    public DetailView detail(long docId) {
        long userId = currentUserId();
        DocumentRow row = requireVisible(docId, userId);
        int permission = permission(row, userId);
        return new DetailView(
                row.id(), row.title(), parseContent(row.content()), row.revision(),
                row.ownerId(), permission, format(row.updateTime()));
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
    }

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

    private SummaryView summary(DocumentRow row) {
        return new SummaryView(row.id(), row.title(), row.ownerId(), row.ownerName(),
                row.parentId(), format(row.updateTime()));
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
            long id, String title, long ownerId, String ownerName, long parentId, String updateTime
    ) {
    }

    public record ListView(long total, List<SummaryView> list) {
    }

    public record DetailView(
            long id, String title, JsonNode content, long revision,
            long ownerId, int permission, String updateTime
    ) {
    }

    public record RenameView(long id, String title, String updateTime) {
    }
}
