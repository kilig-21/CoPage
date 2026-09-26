package com.school.collab.collab.ws;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.school.collab.collab.CollabException;
import com.school.collab.collab.service.DocRevService;
import com.school.collab.common.BizException;
import com.school.collab.document.DocumentService;
import com.school.collab.ot.Delta;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.io.IOException;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.locks.ReentrantLock;

@Component
public class CollabWebSocketHandler extends TextWebSocketHandler {

    private static final Logger log = LoggerFactory.getLogger(CollabWebSocketHandler.class);
    private static final ReentrantLock[] SEND_ORDER_LOCKS = new ReentrantLock[256];

    static {
        for (int index = 0; index < SEND_ORDER_LOCKS.length; index++) {
            SEND_ORDER_LOCKS[index] = new ReentrantLock();
        }
    }

    private final ObjectMapper objectMapper;
    private final DocRevService docRevService;
    private final DocumentService documents;
    private final WsSessionRegistry registry;
    private final WsSender sender;

    public CollabWebSocketHandler(
            ObjectMapper objectMapper,
            DocRevService docRevService,
            DocumentService documents,
            WsSessionRegistry registry,
            WsSender sender
    ) {
        this.objectMapper = objectMapper;
        this.docRevService = docRevService;
        this.documents = documents;
        this.registry = registry;
        this.sender = sender;
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) {
        try {
            JsonNode payload = objectMapper.readTree(message.getPayload());
            String type = requiredText(payload, "type");
            switch (type) {
                case "join" -> join(session, payload);
                case "op" -> commit(session, payload);
                case "cursor" -> cursor(session, payload);
                case "ping" -> send(session, objectMapper.createObjectNode().put("type", "pong"));
                default -> throw new CollabException(400, "不支持的消息类型: " + type);
            }
        } catch (CollabException exception) {
            sendError(session, exception.getCode(), exception.getMessage());
        } catch (BizException exception) {
            sendError(session, exception.getErrorCode().code(), exception.getMessage());
        } catch (Exception exception) {
            log.warn("处理协同消息失败, session={}", session.getId(), exception);
            sendError(session, 400, "消息格式错误");
        }
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        registry.unregister(session);
    }

    private void join(WebSocketSession session, JsonNode payload) {
        long docId = requiredPositiveLong(payload, "docId");
        String clientId = requiredText(payload, "clientId");
        Long userId = (Long) session.getAttributes().get(WsHandshakeInterceptor.USER_ID);
        String username = (String) session.getAttributes().get(WsHandshakeInterceptor.USERNAME);
        if (userId == null || username == null) {
            throw new CollabException(401, "WebSocket 未认证");
        }

        documents.permissionFor(docId, userId);
        DocRevService.Snapshot snapshot = docRevService.snapshot(docId);
        WsSessionRegistry.SessionInfo info = registry.register(session, docId, clientId, userId, username);

        ObjectNode sync = objectMapper.createObjectNode()
                .put("type", "sync")
                .put("docId", docId)
                .put("revision", snapshot.revision());
        sync.set("content", objectMapper.valueToTree(snapshot.content()));
        sync.set("users", users(docId));
        send(info.session(), sync);
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
            operation = objectMapper.treeToValue(opNode, Delta.class);
        } catch (Exception exception) {
            throw new CollabException(400, "op 不是合法的 Delta");
        }
        // 单实例内把提交和发送放在同一临界区，避免 revision 2 先于 revision 1 广播。
        ReentrantLock sendOrder = SEND_ORDER_LOCKS[(int) Math.floorMod(docId, SEND_ORDER_LOCKS.length)];
        sendOrder.lock();
        try {
            DocRevService.CommitResult result = docRevService.commit(docId, baseRevision, operation);

            ObjectNode ack = objectMapper.createObjectNode()
                    .put("type", "ack")
                    .put("docId", docId)
                    .put("clientId", source.clientId())
                    .put("revision", result.revision());
            send(source.session(), ack);

            ObjectNode remoteOp = objectMapper.createObjectNode()
                    .put("type", "op")
                    .put("docId", docId)
                    .put("originClientId", source.clientId())
                    .put("revision", result.revision());
            remoteOp.set("op", objectMapper.valueToTree(result.operation()));
            for (WsSessionRegistry.SessionInfo target : registry.sessionsOf(docId)) {
                if (!target.sessionId().equals(source.sessionId())) {
                    send(target.session(), remoteOp);
                }
            }
        } finally {
            sendOrder.unlock();
        }
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
        ObjectNode cursor = objectMapper.createObjectNode()
                .put("type", "cursor")
                .put("docId", docId)
                .put("clientId", source.clientId())
                .put("index", index)
                .put("length", length)
                .put("color", colorFor(source.userId()));

        for (WsSessionRegistry.SessionInfo target : registry.sessionsOf(docId)) {
            if (!target.sessionId().equals(source.sessionId())) {
                send(target.session(), cursor);
            }
        }
    }

    private ArrayNode users(long docId) {
        ArrayNode users = objectMapper.createArrayNode();
        Set<Long> seenUsers = new HashSet<>();
        for (WsSessionRegistry.SessionInfo info : registry.sessionsOf(docId)) {
            if (seenUsers.add(info.userId())) {
                users.addObject()
                        .put("userId", info.userId())
                        .put("nickname", info.username())
                        .put("color", colorFor(info.userId()));
            }
        }
        return users;
    }

    private void sendError(WebSocketSession session, int code, String message) {
        send(session, objectMapper.createObjectNode()
                .put("type", "error")
                .put("code", code)
                .put("message", message));
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

    private static long requiredPositiveLong(JsonNode payload, String field) {
        long value = requiredNonNegativeLong(payload, field);
        if (value <= 0) {
            throw new CollabException(400, field + " 必须大于 0");
        }
        return value;
    }

    private static long requiredNonNegativeLong(JsonNode payload, String field) {
        JsonNode node = payload.get(field);
        if (node == null || !node.canConvertToLong() || node.asLong() < 0) {
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
