package com.school.collab.collab.ws;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.connection.Message;
import org.springframework.data.redis.connection.MessageListener;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

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

    public CollabEventBus(
            StringRedisTemplate redis, ObjectMapper objectMapper,
            WsSessionRegistry registry, WsSender sender
    ) {
        this.redis = redis;
        this.objectMapper = objectMapper;
        this.registry = registry;
        this.sender = sender;
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
                if (sameInstance && target.sessionId().equals(originSessionId)) {
                    continue;
                }
                try {
                    sender.send(target.session(), payload);
                } catch (IOException exception) {
                    log.debug("跨实例协同消息发送失败, session={}", target.sessionId(), exception);
                }
            }
        } catch (Exception exception) {
            log.warn("无法解析 Redis 协同广播消息", exception);
        }
    }
}
