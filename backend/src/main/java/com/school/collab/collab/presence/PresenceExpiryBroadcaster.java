package com.school.collab.collab.presence;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.collab.ws.CollabEventBus;
import com.school.collab.collab.ws.CollabMessages;
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
            for (Long docId : presence.documentsWithExpiredPresence()) {
                if (!presence.pruneExpired(docId)) continue;
                eventBus.publish(docId, "", CollabMessages.presence(mapper, docId, presence.users(docId)));
            }
        } catch (RuntimeException exception) {
            log.warn("在线用户过期巡检失败，下轮重试", exception);
        }
    }
}
