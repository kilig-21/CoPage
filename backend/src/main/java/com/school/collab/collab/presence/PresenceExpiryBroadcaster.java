package com.school.collab.collab.presence;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.school.collab.collab.ws.CollabEventBus;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/** 连接所在实例异常退出时，在过期后主动通知剩余在线客户端。 */
@Component
public class PresenceExpiryBroadcaster {
    private static final Logger log = LoggerFactory.getLogger(PresenceExpiryBroadcaster.class);

    private final RedisPresenceStore presence;
    private final CollabEventBus eventBus;
    private final ObjectMapper mapper;

    public PresenceExpiryBroadcaster(RedisPresenceStore presence, CollabEventBus eventBus,
                                     ObjectMapper mapper) {
        this.presence = presence;
        this.eventBus = eventBus;
        this.mapper = mapper;
    }

    @Scheduled(initialDelay = 5_000, fixedDelay = 5_000)
    public void publishExpired() {
        try {
            for (Long docId : presence.documentsWithPresence()) {
                if (!presence.pruneExpired(docId)) continue;
                ObjectNode payload = mapper.createObjectNode()
                        .put("type", "presence")
                        .put("docId", docId);
                payload.set("users", mapper.valueToTree(presence.users(docId)));
                eventBus.publish(docId, "", payload);
            }
        } catch (RuntimeException exception) {
            log.warn("在线用户过期巡检失败，下轮重试", exception);
        }
    }
}
