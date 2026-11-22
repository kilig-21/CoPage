package com.school.collab.collab.ws;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.school.collab.collab.CollabException;
import com.school.collab.collab.presence.RedisPresenceStore;
import com.school.collab.collab.service.DocRevService;
import com.school.collab.auth.AccountSessions;
import com.school.collab.common.BizException;
import com.school.collab.document.DocumentService;
import com.school.collab.document.DocumentFormats;
import com.school.collab.ot.Delta;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.io.IOException;

@Component
public class CollabWebSocketHandler extends TextWebSocketHandler {

    private static final Logger log = LoggerFactory.getLogger(CollabWebSocketHandler.class);
    private static final int MAX_SYNC_BYTES = (3 * 1024 + 64) * 1024;

    private final ObjectMapper objectMapper;
    private final DocRevService docRevService;
    private final DocumentService documents;
    private final WsSessionRegistry registry;
    private final WsSender sender;
    private final CollabEventBus eventBus;
    private final RedisPresenceStore presence;
    private final AccountSessions accounts;

    public CollabWebSocketHandler(
            ObjectMapper objectMapper,
            DocRevService docRevService,
            DocumentService documents,
            WsSessionRegistry registry,
            WsSender sender,
            CollabEventBus eventBus,
            RedisPresenceStore presence, AccountSessions accounts
    ) {
        this.objectMapper = objectMapper;
        this.docRevService = docRevService;
        this.documents = documents;
        this.registry = registry;
        this.sender = sender;
        this.eventBus = eventBus;
        this.presence = presence;
        this.accounts = accounts;
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) throws IOException {
        registry.trackConnection(session);
        try {
            // Close the race between credential validation during upgrade and registration.
            Object user = session.getAttributes().get(WsHandshakeInterceptor.USER_ID);
            if (!(user instanceof Long id) || !WsHandshakeInterceptor.sessionCurrent(session, id, accounts)) {
                session.close(CloseStatus.POLICY_VIOLATION);
            }
        } catch (RuntimeException unavailable) {
            session.close(CloseStatus.SERVER_ERROR);
        }
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) {
        String syncId = null;
        try {
            Object user = session.getAttributes().get(WsHandshakeInterceptor.USER_ID);
            if (!(user instanceof Long id) || !WsHandshakeInterceptor.sessionCurrent(session, id, accounts)) {
                sendError(session, 401, "登录已失效，请重新登录；未确认内容仍保留");
                try { session.close(CloseStatus.POLICY_VIOLATION); } catch (IOException ignored) { }
                return;
            }
            JsonNode payload = objectMapper.readTree(message.getPayload());
            String type = requiredText(payload, "type");
            if (type.equals("join") || type.equals("history_request")) syncId = optionalBoundedText(payload, "syncId", 128);
            switch (type) {
                case "join" -> join(session, payload);
                case "op" -> commit(session, payload);
                case "history_request" -> historyPage(session, payload);
                case "cursor" -> cursor(session, payload);
                case "ping" -> ping(session);
                default -> throw new CollabException(400, "不支持的消息类型: " + type);
            }
        } catch (CollabException exception) {
            sendError(session, exception.getCode(), exception.getMessage(), syncId);
        } catch (BizException exception) {
            sendError(session, exception.getErrorCode().code(), exception.getMessage(), syncId);
        } catch (JsonProcessingException | IllegalArgumentException exception) {
            sendError(session, 400, "消息格式错误", syncId);
        } catch (Exception exception) {
            log.warn("处理协同消息失败, session={}", session.getId(), exception);
            sendError(session, 500, "服务端处理失败，请稍后重新同步", syncId);
        }
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        registry.untrackConnection(session);
        WsSessionRegistry.SessionInfo info = registry.current(session);
        registry.unregister(session);
        if (info != null) {
            publishHiddenCursor(info);
            presence.leave(info, eventBus.instanceId());
            publishPresence(info.docId());
        }
    }

    private void join(WebSocketSession session, JsonNode payload) throws JsonProcessingException {
        long docId = requiredPositiveLong(payload, "docId");
        String clientId = requiredText(payload, "clientId");
        if (clientId.length() > 255) {
            throw new CollabException(400, "clientId 长度非法");
        }
        long lastRevision = requiredNonNegativeLong(payload, "lastRevision");
        String syncId = optionalBoundedText(payload, "syncId", 128);
        var pending = readPending(payload);
        Long userId = (Long) session.getAttributes().get(WsHandshakeInterceptor.USER_ID);
        String nickname = (String) session.getAttributes().get(WsHandshakeInterceptor.NICKNAME);
        if (userId == null || nickname == null) {
            throw new CollabException(401, "WebSocket 未认证");
        }

        documents.permissionFor(docId, userId);
        var previous = registry.current(session);
        var state = docRevService.joinState(docId, lastRevision, userId, clientId, pending,
                ignored -> registry.register(session, docId, clientId, userId, nickname));
        var info = registry.current(session);
        if (info == null || !session.isOpen()) return;
        if (previous != null) {
            publishHiddenCursor(previous);
            presence.leave(previous, eventBus.instanceId());
            if (previous.docId() != docId) publishPresence(previous.docId());
        }
        presence.join(info, eventBus.instanceId());
        if (!session.isOpen() || !info.equals(registry.current(session))) {
            presence.leave(info, eventBus.instanceId());
            return;
        }
        ObjectNode sync = objectMapper.createObjectNode()
                .put("type", "sync").put("docId", docId)
                .put("permission", documents.permissionFor(docId, userId))
                .put("fromRevision", lastRevision).put("revision", state.revision())
                .put("historyComplete", state.historyComplete()).put("historyPaged", state.historyPaged());
        if (syncId != null) sync.put("syncId", syncId);
        sync.set("content", objectMapper.valueToTree(state.content()));
        sync.set("pendingCommittedRevision", objectMapper.valueToTree(state.pendingCommittedRevision()));
        var history = sync.putArray("history");
        state.history().forEach(entry -> history.addObject().put("revision", entry.revision())
                .set("op", objectMapper.valueToTree(entry.operation())));
        sync.set("users", objectMapper.valueToTree(presence.users(docId)));
        if (objectMapper.writeValueAsBytes(sync).length > MAX_SYNC_BYTES) {
            if (!history.isEmpty()) {
                history.removeAll();
                sync.put("historyComplete", false).put("historyPaged", true);
            }
            // presence 会在同步后独立广播，给快照和恢复元数据保留空间。
            sync.putArray("users");
            if (objectMapper.writeValueAsBytes(sync).length > MAX_SYNC_BYTES) {
                throw new CollabException(40903, "文档快照超出协同消息上限，已保留本地内容");
            }
        }
        send(info.session(), sync);
        publishPresence(docId);
    }

    private void historyPage(WebSocketSession session, JsonNode payload) {
        var info = registry.require(session);
        long docId = requiredPositiveLong(payload, "docId");
        if (info.docId() != docId) throw new CollabException(403, "未加入该文档");
        String syncId = requiredText(payload, "syncId");
        if (syncId.length() > 128) throw new CollabException(400, "syncId 过长");
        documents.permissionFor(docId, info.userId());
        long after = requiredNonNegativeLong(payload, "afterRevision");
        long through = requiredNonNegativeLong(payload, "throughRevision");
        var pending = readPending(payload);
        var page = pending == null ? docRevService.historyPage(docId, after, through)
                : docRevService.historyPage(docId, after, through, info.userId(), info.clientId(), pending);
        var response = objectMapper.createObjectNode().put("type", "history_page").put("docId", docId)
                .put("syncId", syncId).put("fromRevision", page.fromRevision()).put("toRevision", page.toRevision())
                .put("revision", page.revision()).put("permission", documents.permissionFor(docId, info.userId()));
        if (pending != null) response.set("pendingCommittedRevision", objectMapper.valueToTree(page.pendingCommittedRevision()));
        // VersionedOperation 字段名为 operation，协议仍使用 op。
        var history = response.putArray("history");
        page.history().forEach(entry -> history.addObject().put("revision", entry.revision())
                .set("op", objectMapper.valueToTree(entry.operation())));
        send(info.session(), response);
    }

    private void commit(WebSocketSession session, JsonNode payload) {
        WsSessionRegistry.SessionInfo source = registry.require(session);
        long docId = requiredPositiveLong(payload, "docId");
        if (source.docId() != docId) {
            throw new CollabException(403, "当前会话未加入该文档");
        }
        String clientId = requiredText(payload, "clientId");
        if (!source.clientId().equals(clientId)) {
            throw new CollabException(403, "clientId 与当前会话不匹配");
        }
        String opId = optionalOpId(payload, clientId);
        if (documents.permissionFor(docId, source.userId()) != 2) {
            throw new CollabException(403, "当前用户没有文档编辑权限");
        }
        long baseRevision = requiredNonNegativeLong(payload, "baseRevision");
        JsonNode opNode = payload.get("op");
        if (opNode == null || opNode.isNull()) {
            throw new CollabException(400, "缺少 op");
        }

        Delta operation;
        try {
            DocumentFormats.validateEditorOperation(opNode);
            operation = objectMapper.treeToValue(opNode, Delta.class);
        } catch (Exception exception) {
            throw new CollabException(400, "op 不是合法的 Delta");
        }
        DocRevService.CommitResult result = docRevService.commit(
                docId, baseRevision, operation, source.userId(),
                opId == null ? null : clientId, opId, committed -> {
            // ACK 与广播都在文档锁释放后发送。
            sendAck(source, docId, committed.revision(), opId);

            ObjectNode remoteOp = objectMapper.createObjectNode()
                    .put("type", "op")
                    .put("docId", docId)
                    .put("originClientId", source.clientId())
                    .put("revision", committed.revision());
            if (opId != null) {
                remoteOp.put("opId", opId);
            }
            remoteOp.set("op", objectMapper.valueToTree(committed.operation()));
            try {
                eventBus.publish(docId, source.sessionId(), remoteOp);
            } catch (RuntimeException exception) {
                log.error("操作已提交，但 Redis 广播失败, docId={}, revision={}",
                        docId, committed.revision(), exception);
            }
        });
        if (!result.applied()) {
            // 已落库操作的重试只补发原 ack，不能再次广播。
            sendAck(source, docId, result.revision(), opId);
        }
    }

    private void sendAck(WsSessionRegistry.SessionInfo source, long docId, long revision, String opId) {
        ObjectNode ack = objectMapper.createObjectNode()
                .put("type", "ack")
                .put("docId", docId)
                .put("clientId", source.clientId())
                .put("revision", revision);
        if (opId != null) {
            ack.put("opId", opId);
        }
        send(source.session(), ack);
    }

    private void cursor(WebSocketSession session, JsonNode payload) {
        WsSessionRegistry.SessionInfo source = registry.require(session);
        long docId = requiredPositiveLong(payload, "docId");
        if (source.docId() != docId) {
            throw new CollabException(403, "当前会话未加入该文档");
        }
        documents.permissionFor(docId, source.userId());

        int index = requiredNonNegativeInt(payload, "index");
        int length = requiredNonNegativeInt(payload, "length");
        JsonNode visibleNode = payload.get("visible");
        if (visibleNode != null && !visibleNode.isBoolean()) {
            throw new CollabException(400, "visible 必须是布尔值");
        }
        boolean visible = visibleNode == null || visibleNode.asBoolean();
        ObjectNode cursor = objectMapper.createObjectNode()
                .put("type", "cursor")
                .put("docId", docId)
                .put("clientId", source.clientId())
                .put("index", index)
                .put("length", length)
                .put("visible", visible)
                .put("nickname", source.nickname())
                .put("color", colorFor(source.userId()));

        eventBus.publish(docId, source.sessionId(), cursor);
    }

    private void ping(WebSocketSession session) {
        WsSessionRegistry.SessionInfo info = registry.current(session);
        ObjectNode pong = objectMapper.createObjectNode().put("type", "pong");
        if (info != null) {
            pong.put("permission", documents.permissionFor(info.docId(), info.userId()));
            if (!presence.heartbeat(info, eventBus.instanceId())) {
                Boolean rejoined = docRevService.maintenanceLock(info.docId(), () -> {
                    documents.permissionFor(info.docId(), info.userId());
                    if (!session.isOpen() || !info.equals(registry.current(session))) return false;
                    presence.join(info, eventBus.instanceId());
                    return true;
                });
                if (Boolean.TRUE.equals(rejoined)) publishPresence(info.docId());
            }
            pong.put("docId", info.docId()).put("revision", docRevService.currentRevision(info.docId()));
        }
        send(session, pong);
    }

    private void publishPresence(long docId) {
        ObjectNode payload = objectMapper.createObjectNode()
                .put("type", "presence")
                .put("docId", docId);
        payload.set("users", objectMapper.valueToTree(presence.users(docId)));
        eventBus.publish(docId, "", payload);
    }

    private void publishHiddenCursor(WsSessionRegistry.SessionInfo info) {
        ObjectNode cursor = objectMapper.createObjectNode()
                .put("type", "cursor")
                .put("docId", info.docId())
                .put("clientId", info.clientId())
                .put("index", 0)
                .put("length", 0)
                .put("visible", false)
                .put("nickname", info.nickname())
                .put("color", colorFor(info.userId()));
        try {
            eventBus.publish(info.docId(), info.sessionId(), cursor);
        } catch (RuntimeException exception) {
            log.debug("离开时广播光标隐藏失败, docId={}", info.docId(), exception);
        }
    }

    private void sendError(WebSocketSession session, int code, String message) {
        sendError(session, code, message, null);
    }

    private void sendError(WebSocketSession session, int code, String message, String syncId) {
        var response = objectMapper.createObjectNode()
                .put("type", "error")
                .put("code", code)
                .put("message", message);
        if (syncId != null) response.put("syncId", syncId);
        send(session, response);
    }

    private void send(WebSocketSession session, JsonNode payload) {
        try {
            sender.send(session, payload);
        } catch (IOException exception) {
            log.debug("发送 WebSocket 消息失败, session={}", session.getId(), exception);
        }
    }

    private static String requiredText(JsonNode payload, String field) {
        JsonNode node = payload.get(field);
        if (node == null || !node.isTextual() || node.asText().isBlank()) {
            throw new CollabException(400, "缺少或非法字段: " + field);
        }
        return node.asText();
    }

    private static String optionalOpId(JsonNode payload, String clientId) {
        JsonNode node = payload.get("opId");
        if (node == null) {
            return null;
        }
        if (!node.isTextual() || node.asText().isBlank() || node.asText().length() > 128
                || clientId.length() > 255) {
            throw new CollabException(400, "opId 或 clientId 长度非法");
        }
        return node.asText();
    }

    private static String optionalBoundedText(JsonNode payload, String field, int limit) {
        JsonNode node = payload.get(field);
        if (node == null || node.isNull()) return null;
        if (!node.isTextual() || node.asText().isBlank() || node.asText().length() > limit) {
            throw new CollabException(400, "非法字段: " + field);
        }
        return node.asText();
    }

    private DocRevService.PendingOperation readPending(JsonNode payload) {
        var id = optionalBoundedText(payload, "pendingOpId", 128);
        return id == null ? null : new DocRevService.PendingOperation(id,
                requiredNonNegativeLong(payload, "pendingBaseRevision"), readOperation(payload, "pendingOp"));
    }

    private Delta readOperation(JsonNode payload, String field) {
        JsonNode node = payload.get(field);
        if (node == null || node.isNull()) throw new CollabException(400, "缺少 " + field);
        try {
            DocumentFormats.validateEditorOperation(node);
            return objectMapper.treeToValue(node, Delta.class);
        } catch (Exception exception) {
            throw new CollabException(400, field + " 不是合法的 Delta");
        }
    }

    private static long requiredPositiveLong(JsonNode payload, String field) {
        long value = requiredNonNegativeLong(payload, field);
        if (value <= 0) {
            throw new CollabException(400, field + " 必须大于 0");
        }
        return value;
    }

    private static long requiredNonNegativeLong(JsonNode payload, String field) {
        JsonNode node = payload.get(field);
        if (node == null || !node.isIntegralNumber() || !node.canConvertToLong() || node.asLong() < 0) {
            throw new CollabException(400, "缺少或非法字段: " + field);
        }
        return node.asLong();
    }

    private static int requiredNonNegativeInt(JsonNode payload, String field) {
        JsonNode node = payload.get(field);
        if (node == null || !node.canConvertToInt() || node.asInt() < 0) {
            throw new CollabException(400, "缺少或非法字段: " + field);
        }
        return node.asInt();
    }

    private static String colorFor(long userId) {
        String[] colors = {"#2563eb", "#db2777", "#059669", "#d97706", "#7c3aed"};
        return colors[(int) Math.floorMod(userId, colors.length)];
    }
}
