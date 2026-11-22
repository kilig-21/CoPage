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

import java.util.UUID;

/** Redis Pub/Sub 承载跨实例 op/cursor 广播；同一实例也通过它走唯一发送路径。 */
@Component
public class CollabEventBus implements MessageListener {
    public static final String CHANNEL = "collab:events";
    private static final Logger log = LoggerFactory.getLogger(CollabEventBus.class);

    private final String instanceId = UUID.randomUUID().toString();
    private final StringRedisTemplate redis;
    private final ObjectMapper objectMapper;
    private final CollabEventDelivery delivery;

    public CollabEventBus(StringRedisTemplate redis, ObjectMapper objectMapper, CollabEventDelivery delivery) {
        this.redis = redis;
        this.objectMapper = objectMapper;
        this.delivery = delivery;
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
            JsonNode payload = envelope.path("payload");
            if ("account_changed".equals(payload.path("type").asText())) {
                delivery.accountChanged(envelope.path("userId").asLong());
                return;
            }
            long docId = envelope.path("docId").asLong();
            if (docId <= 0 || !payload.isObject()) {
                log.warn("忽略非法协同广播消息");
                return;
            }
            String excluded = instanceId.equals(envelope.path("instanceId").asText()) ? envelope.path("sessionId").asText() : null;
            delivery.documentChanged(docId, excluded, payload);
        } catch (Exception exception) {
            log.warn("无法解析 Redis 协同广播消息", exception);
        }
    }

    public void publishAccountChanged(long userId) {
        var envelope = objectMapper.createObjectNode().put("instanceId", instanceId).put("userId", userId);
        envelope.set("payload", objectMapper.createObjectNode().put("type", "account_changed"));
        redis.convertAndSend(CHANNEL, envelope.toString());
    }

}
