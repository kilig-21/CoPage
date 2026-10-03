package com.school.collab.document;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.collab.ws.CollabEventBus;
import com.school.collab.common.BizException;
import com.school.collab.common.ErrorCode;
import com.school.collab.common.UserContext;
import com.school.collab.document.DocumentRepository.CollaboratorView;
import com.school.collab.document.DocumentRepository.DocumentRow;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.List;

@Service
public class CollaboratorService {
    private static final Logger log = LoggerFactory.getLogger(CollaboratorService.class);
    private final DocumentRepository documents;
    private final CollabEventBus events;
    private final ObjectMapper mapper;

    public CollaboratorService(DocumentRepository documents, CollabEventBus events, ObjectMapper mapper) {
        this.documents = documents;
        this.events = events;
        this.mapper = mapper;
    }

    public List<CollaboratorView> list(long docId) {
        requireOwner(docId, false);
        return documents.collaborators(docId);
    }

    @Transactional
    public void invite(long docId, String username, int permission) {
        DocumentRow doc = requireOwner(docId, true);
        validatePermission(permission);
        String normalized = username == null ? "" : username.trim();
        if (normalized.length() < 3 || normalized.length() > 50) {
            throw new BizException(ErrorCode.PARAM_ERROR, "请输入 3～50 字符的已注册用户名");
        }
        var account = documents.accountByUsername(normalized)
                .orElseThrow(() -> new BizException(ErrorCode.NOT_FOUND, "该用户名尚未注册"));
        validateMember(doc, account.id());
        try {
            documents.addCollaborator(docId, account.id(), permission);
        } catch (DuplicateKeyException exception) {
            throw new BizException(ErrorCode.PARAM_ERROR, "该用户已是协作者，请在列表中修改权限");
        }
        notifyAfterCommit(docId, account.id());
    }

    @Transactional
    public void change(long docId, long userId, int permission) {
        DocumentRow doc = requireOwner(docId, true);
        validatePermission(permission);
        requireMember(doc, userId);
        documents.changeCollaborator(docId, userId, permission);
        notifyAfterCommit(docId, userId);
    }

    @Transactional
    public void remove(long docId, long userId) {
        DocumentRow doc = requireOwner(docId, true);
        requireMember(doc, userId);
        documents.removeCollaborator(docId, userId);
        notifyAfterCommit(docId, userId);
    }

    private DocumentRow requireOwner(long docId, boolean lock) {
        Long userId = UserContext.getUserId();
        if (userId == null) throw new BizException(ErrorCode.UNAUTHORIZED);
        if (docId <= 0) throw new BizException(ErrorCode.PARAM_ERROR);
        DocumentRow doc = (lock ? documents.findForUpdate(docId) : documents.find(docId))
                .orElseThrow(() -> new BizException(ErrorCode.NOT_FOUND));
        if (doc.ownerId() != userId) throw new BizException(ErrorCode.FORBIDDEN);
        return doc;
    }

    private void requireMember(DocumentRow doc, long userId) {
        validateMember(doc, userId);
        if (documents.collaboratorPermission(doc.id(), userId) == 0) {
            throw new BizException(ErrorCode.NOT_FOUND, "该用户不是此文档的协作者");
        }
    }

    private static void validateMember(DocumentRow doc, long userId) {
        if (userId <= 0 || doc.ownerId() == userId) {
            throw new BizException(ErrorCode.PARAM_ERROR, "不能修改文档所有者的权限");
        }
    }

    private static void validatePermission(int permission) {
        if (permission != 1 && permission != 2) {
            throw new BizException(ErrorCode.PARAM_ERROR, "权限只能为只读或可编辑");
        }
    }

    private void notifyAfterCommit(long docId, long userId) {
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                try {
                    events.publish(docId, "", mapper.createObjectNode().put("type", "permission")
                            .put("docId", docId).put("userId", userId));
                } catch (RuntimeException exception) {
                    // 权限已落库，不能将提交成功伪装成失败；广播仍逐次查库，心跳可补通知。
                    log.warn("协作者权限已提交，实时通知暂时失败, docId={}, userId={}", docId, userId, exception);
                }
            }
        });
    }
}
