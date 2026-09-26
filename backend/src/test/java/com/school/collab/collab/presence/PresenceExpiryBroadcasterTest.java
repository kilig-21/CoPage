package com.school.collab.collab.presence;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.collab.ws.CollabEventBus;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class PresenceExpiryBroadcasterTest {
    private final RedisPresenceStore presence = mock(RedisPresenceStore.class);
    private final CollabEventBus eventBus = mock(CollabEventBus.class);
    private final PresenceExpiryBroadcaster broadcaster =
            new PresenceExpiryBroadcaster(presence, eventBus, new ObjectMapper());

    @Test
    void 仅过期清理成功的实例广播剩余在线用户() {
        when(presence.documentsWithPresence()).thenReturn(List.of(5L, 6L));
        when(presence.pruneExpired(5)).thenReturn(true);
        when(presence.users(5)).thenReturn(List.of(
                new RedisPresenceStore.PresenceUser(1, "A", "#2563eb")));

        broadcaster.publishExpired();

        ArgumentCaptor<JsonNode> payload = ArgumentCaptor.forClass(JsonNode.class);
        verify(eventBus).publish(eq(5L), eq(""), payload.capture());
        assertEquals("presence", payload.getValue().path("type").asText());
        assertEquals(1, payload.getValue().path("users").size());
        assertEquals(1, payload.getValue().path("users").get(0).path("userId").asInt());
        verify(presence).pruneExpired(6);
    }

    @Test
    void 无过期会话时不广播() {
        when(presence.documentsWithPresence()).thenReturn(List.of(5L));

        broadcaster.publishExpired();

        verifyNoInteractions(eventBus);
    }
}
