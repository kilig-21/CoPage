package com.school.collab.collab.ws;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.school.collab.common.BizException;
import com.school.collab.common.ErrorCode;
import com.school.collab.document.DocumentService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.connection.Message;
import org.springframework.data.redis.connection.MessageListener;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;

import java.io.IOException;
import java.util.UUID;

/** Redis Pub/Sub 承载跨实例 op/cursor 广播；同一实例也通过它走唯一发送路径。 */
@Component
public class CollabEventBus implements MessageListener {
    public static final String CHANNEL = "collab:events";
    private static final Logger log = LoggerFactory.getLogger(CollabEventBus.class);

    private final String instanceId = UUID.randomUUID().toString();
    private final StringRedisTemplate redis;
    private final ObjectMapper objectMapper;
    private final WsSessionRegistry registry;
    private final WsSender sender;
    private final DocumentService documents;

    public CollabEventBus(
            StringRedisTemplate redis, ObjectMapper objectMapper,
            WsSessionRegistry registry, WsSender sender, DocumentService documents
    ) {
        this.redis = redis;
        this.objectMapper = objectMapper;
        this.registry = registry;
        this.sender = sender;
        this.documents = documents;
    }

    public String instanceId() {
        return instanceId;
    }

    public void publish(long docId, String originSessionId, JsonNode payload) {
        ObjectNode envelope = objectMapper.createObjectNode()
                .put("instanceId", instanceId)
                .put("sessionId", originSessionId)
                .put("docId", docId);
        envelope.set("payload", payload);
        redis.convertAndSend(CHANNEL, envelope.toString());
    }

    @Override
    public void onMessage(Message message, byte[] pattern) {
        try {
            JsonNode envelope = objectMapper.readTree(message.getBody());
            long docId = envelope.path("docId").asLong();
            JsonNode payload = envelope.path("payload");
            if (docId <= 0 || !payload.isObject()) {
                log.warn("忽略非法协同广播消息");
                return;
            }
            boolean sameInstance = instanceId.equals(envelope.path("instanceId").asText());
            String originSessionId = envelope.path("sessionId").asText();
            for (WsSessionRegistry.SessionInfo target : registry.sessionsOf(docId)) {
                boolean permissionEvent = "permission".equals(payload.path("type").asText());
                if (permissionEvent && payload.has("userId") && payload.path("userId").asLong() != target.userId()) continue;
                if (sameInstance && target.sessionId().equals(originSessionId)) {
                    continue;
                }
                try {
                    // 每次转发前以 MySQL 为准，不能依赖异步权限事件顺序或失效的会话权限。
                    int permission = currentPermission(docId, target.userId());
                    sender.send(target.session(), objectMapper.createObjectNode()
                            .put("type", "permission").put("docId", docId).put("permission", permission));
                    if (permission == 0) {
                        target.session().close(CloseStatus.POLICY_VIOLATION);
                    } else if (!permissionEvent) {
                        sender.send(target.session(), payload);
                    }
                } catch (IOException exception) {
                    log.debug("跨实例协同消息发送失败, session={}", target.sessionId(), exception);
                }
            }
        } catch (Exception exception) {
            log.warn("无法解析 Redis 协同广播消息", exception);
        }
    }

    private int currentPermission(long docId, long userId) {
        try {
            return documents.permissionFor(docId, userId);
        } catch (BizException exception) {
            if (exception.getErrorCode() == ErrorCode.FORBIDDEN || exception.getErrorCode() == ErrorCode.NOT_FOUND) {
                return 0;
            }
            throw exception;
        }
    }
}
