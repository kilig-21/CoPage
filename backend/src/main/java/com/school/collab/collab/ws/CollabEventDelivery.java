package com.school.collab.collab.ws;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.auth.AccountSessions;
import com.school.collab.common.BizException;
import com.school.collab.common.ErrorCode;
import com.school.collab.document.DocumentService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.WebSocketSession;

import java.io.IOException;

/** Local WebSocket delivery checks current credentials and document access for each recipient. */
@Component
final class CollabEventDelivery {
    private static final Logger log = LoggerFactory.getLogger(CollabEventDelivery.class);

    private final ObjectMapper mapper;
    private final WsSessionRegistry registry;
    private final WsSender sender;
    private final DocumentService documents;
    private final AccountSessions accounts;

    CollabEventDelivery(ObjectMapper mapper, WsSessionRegistry registry, WsSender sender,
                        DocumentService documents, AccountSessions accounts) {
        this.mapper = mapper;
        this.registry = registry;
        this.sender = sender;
        this.documents = documents;
        this.accounts = accounts;
    }

    void accountChanged(long userId) {
        if (userId <= 0) return;
        for (var target : registry.connectionsOfUser(userId)) {
            try { rejectExpired(target, userId); } catch (IOException | IllegalStateException ignored) { }
        }
    }

    void documentChanged(long docId, String excludedSession, JsonNode payload) {
        boolean permissionEvent = "permission".equals(payload.path("type").asText());
        for (var target : registry.sessionsOf(docId)) {
            if (permissionEvent && payload.has("userId") && payload.path("userId").asLong() != target.userId()) continue;
            if (target.sessionId().equals(excludedSession)) continue;
            try {
                if (rejectExpired(target.session(), target.userId())) continue;
                int permission = currentPermission(docId, target.userId());
                sender.send(target.session(), mapper.createObjectNode()
                        .put("type", "permission").put("docId", docId).put("permission", permission));
                if (permission == 0) {
                    target.session().close(CloseStatus.POLICY_VIOLATION);
                } else if (!permissionEvent) {
                    sender.send(target.session(), payload);
                }
            } catch (IOException | IllegalStateException exception) {
                // The connection can close between the open check and delivery.
                log.debug("跨实例协同消息发送失败, session={}", target.sessionId(), exception);
            }
        }
    }

    private boolean rejectExpired(WebSocketSession session, long userId) throws IOException {
        if (WsHandshakeInterceptor.sessionCurrent(session, userId, accounts)) return false;
        try {
            sender.send(session, mapper.createObjectNode().put("type", "error").put("code", 401)
                    .put("message", "登录已失效，请重新登录；未确认内容仍保留"));
        } finally {
            session.close(CloseStatus.POLICY_VIOLATION);
        }
        return true;
    }

    private int currentPermission(long docId, long userId) {
        try {
            return documents.permissionFor(docId, userId);
        } catch (BizException exception) {
            if (exception.getErrorCode() == ErrorCode.FORBIDDEN || exception.getErrorCode() == ErrorCode.NOT_FOUND) return 0;
            throw exception;
        }
    }
}
