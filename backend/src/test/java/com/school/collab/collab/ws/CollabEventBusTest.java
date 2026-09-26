package com.school.collab.collab.ws;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.data.redis.connection.Message;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.web.socket.WebSocketSession;

import java.nio.charset.StandardCharsets;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

class CollabEventBusTest {
    private final StringRedisTemplate redis = mock(StringRedisTemplate.class);
    private final ObjectMapper objectMapper = new ObjectMapper();
    private final WsSessionRegistry registry = mock(WsSessionRegistry.class);
    private final WsSender sender = mock(WsSender.class);
    private final CollabEventBus bus = new CollabEventBus(redis, objectMapper, registry, sender);

    @Test
    void localOriginIsSkippedButOtherLocalSessionsReceiveBroadcast() throws Exception {
        WebSocketSession origin = mock(WebSocketSession.class);
        WebSocketSession other = mock(WebSocketSession.class);
        when(registry.sessionsOf(9L)).thenReturn(List.of(
                new WsSessionRegistry.SessionInfo("origin", origin, 9L, "a", 1L, "testA"),
                new WsSessionRegistry.SessionInfo("other", other, 9L, "b", 2L, "testB")));
        JsonNode operation = objectMapper.readTree(
                "{\"type\":\"op\",\"docId\":9,\"revision\":1,\"op\":{\"ops\":[{\"insert\":\"X\"}]}}");

        bus.publish(9L, "origin", operation);
        ArgumentCaptor<Object> published = ArgumentCaptor.forClass(Object.class);
        verify(redis).convertAndSend(eq(CollabEventBus.CHANNEL), published.capture());
        Message message = mock(Message.class);
        when(message.getBody()).thenReturn(
                published.getValue().toString().getBytes(StandardCharsets.UTF_8));

        bus.onMessage(message, null);

        verify(sender, never()).send(eq(origin), eq(operation));
        verify(sender).send(eq(other), eq(operation));
        assertEquals(9L, objectMapper.readTree(published.getValue().toString()).get("docId").asLong());
    }
}
