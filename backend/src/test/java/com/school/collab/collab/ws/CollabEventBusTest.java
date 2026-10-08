package com.school.collab.collab.ws;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.common.BizException;
import com.school.collab.common.ErrorCode;
import com.school.collab.document.DocumentService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.BeforeEach;
import com.school.collab.auth.AccountSessions;
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
    private final DocumentService documents = mock(DocumentService.class);
    private final AccountSessions accounts = mock(AccountSessions.class);
    private final CollabEventBus bus = new CollabEventBus(redis, objectMapper, registry, sender, documents, accounts);
    @BeforeEach void validSessions() { when(accounts.isCurrent(anyLong(),anyLong())).thenReturn(true); }

    @Test
    void lostPasswordNotificationStillCannotLeakDocumentToOldCredential() throws Exception {
        WebSocketSession old=mock(WebSocketSession.class);
        when(old.getAttributes()).thenReturn(java.util.Map.of(WsHandshakeInterceptor.CREDENTIAL_VERSION,0L));
        when(registry.sessionsOf(9L)).thenReturn(List.of(new WsSessionRegistry.SessionInfo("old",old,9L,"a",1L,"owner")));
        when(accounts.isCurrent(1L,0L)).thenReturn(false);
        JsonNode payload=objectMapper.readTree("{\"type\":\"op\",\"docId\":9,\"revision\":2}");
        deliver(payload);
        verify(sender,never()).send(old,payload);
        verify(sender).send(eq(old),argThat(node->node.path("code").asInt()==401));
        verify(old).close(org.springframework.web.socket.CloseStatus.POLICY_VIOLATION);
        verifyNoInteractions(documents);
    }
    @Test
    void delayedPasswordNotificationDoesNotCloseCurrentCredential() throws Exception {
        WebSocketSession current=mock(WebSocketSession.class);
        when(current.getAttributes()).thenReturn(java.util.Map.of(WsHandshakeInterceptor.CREDENTIAL_VERSION,4L));
        when(registry.sessionsOfUser(1L)).thenReturn(List.of(new WsSessionRegistry.SessionInfo("new",current,9L,"a",1L,"owner")));
        when(accounts.isCurrent(1L,4L)).thenReturn(true);
        bus.publishAccountChanged(1);
        var body=ArgumentCaptor.forClass(Object.class);
        verify(redis).convertAndSend(eq(CollabEventBus.CHANNEL),body.capture());
        Message message=mock(Message.class);when(message.getBody()).thenReturn(body.getValue().toString().getBytes(StandardCharsets.UTF_8));
        bus.onMessage(message,null);
        verify(sender,never()).send(eq(current),any());verify(current,never()).close(any());
    }

    @Test
    void concurrentlyClosedSessionDoesNotPreventOtherPeersReceivingOperation() throws Exception {
        WebSocketSession closing = mock(WebSocketSession.class);
        WebSocketSession healthy = mock(WebSocketSession.class);
        when(registry.sessionsOf(9L)).thenReturn(List.of(
                new WsSessionRegistry.SessionInfo("closing", closing, 9L, "a", 1L, "owner"),
                new WsSessionRegistry.SessionInfo("healthy", healthy, 9L, "b", 2L, "member")));
        when(documents.permissionFor(eq(9L), anyLong())).thenReturn(2);
        doThrow(new IllegalStateException("WebSocket session has been closed"))
                .when(sender).send(eq(closing), any());
        JsonNode payload = objectMapper.readTree("{\"type\":\"op\",\"docId\":9,\"revision\":2}");

        deliver(payload);

        verify(sender).send(eq(healthy), argThat(node -> node.path("type").asText().equals("permission")));
        verify(sender).send(healthy, payload);
    }

    @Test
    void failureClosingOneRevokedSessionDoesNotPreventOtherRevocations() throws Exception {
        WebSocketSession closing = mock(WebSocketSession.class);
        WebSocketSession healthy = mock(WebSocketSession.class);
        when(registry.sessionsOf(9L)).thenReturn(List.of(
                new WsSessionRegistry.SessionInfo("closing", closing, 9L, "a", 1L, "owner"),
                new WsSessionRegistry.SessionInfo("healthy", healthy, 9L, "b", 2L, "member")));
        when(documents.permissionFor(eq(9L), anyLong())).thenReturn(0);
        doThrow(new IllegalStateException("WebSocket session has been closed"))
                .when(closing).close(any());

        deliver(objectMapper.readTree("{\"type\":\"permission\",\"docId\":9}"));

        verify(sender).send(eq(healthy), argThat(node -> node.path("permission").asInt() == 0));
        verify(healthy).close(org.springframework.web.socket.CloseStatus.POLICY_VIOLATION);
    }

    @Test
    void localOriginIsSkippedButOtherLocalSessionsReceiveBroadcast() throws Exception {
        WebSocketSession origin = mock(WebSocketSession.class);
        WebSocketSession other = mock(WebSocketSession.class);
        when(registry.sessionsOf(9L)).thenReturn(List.of(
                new WsSessionRegistry.SessionInfo("origin", origin, 9L, "a", 1L, "testA"),
                new WsSessionRegistry.SessionInfo("other", other, 9L, "b", 2L, "testB")));
        when(documents.permissionFor(9L, 2L)).thenReturn(2);
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

    @Test
    void revokedSessionNeverReceivesDocumentBroadcastEvenWhenPermissionNotificationWasLost() throws Exception {
        WebSocketSession revoked = mock(WebSocketSession.class);
        when(registry.sessionsOf(9L)).thenReturn(List.of(
                new WsSessionRegistry.SessionInfo("revoked", revoked, 9L, "b", 2L, "testB")));
        when(documents.permissionFor(9L, 2L)).thenThrow(new BizException(ErrorCode.FORBIDDEN));
        JsonNode payload = objectMapper.readTree("{\"type\":\"op\",\"docId\":9,\"revision\":2}");
        deliver(payload);
        verify(sender, never()).send(revoked, payload);
        verify(sender).send(eq(revoked), argThat(node -> node.path("type").asText().equals("permission")
                && node.path("permission").asInt() == 0));
        verify(revoked).close(org.springframework.web.socket.CloseStatus.POLICY_VIOLATION);
    }

    @Test
    void permissionEventOnlyTargetsMemberAndRechecksDatabaseInsteadOfTrustingStalePayload() throws Exception {
        WebSocketSession owner = mock(WebSocketSession.class);
        WebSocketSession member = mock(WebSocketSession.class);
        when(registry.sessionsOf(9L)).thenReturn(List.of(
                new WsSessionRegistry.SessionInfo("owner", owner, 9L, "a", 1L, "owner"),
                new WsSessionRegistry.SessionInfo("member", member, 9L, "b", 2L, "member")));
        when(documents.permissionFor(9L, 2L)).thenReturn(1);
        deliver(objectMapper.readTree("{\"type\":\"permission\",\"docId\":9,\"userId\":2,\"permission\":2}"));
        verify(sender, never()).send(eq(owner), any());
        verify(sender).send(eq(member), argThat(node -> node.path("permission").asInt() == 1));
    }

    @Test
    void deletionEventClosesBothOwnerAndMemberSessions() throws Exception {
        WebSocketSession owner = mock(WebSocketSession.class);
        WebSocketSession member = mock(WebSocketSession.class);
        when(registry.sessionsOf(9L)).thenReturn(List.of(
                new WsSessionRegistry.SessionInfo("owner", owner, 9L, "a", 1L, "owner"),
                new WsSessionRegistry.SessionInfo("member", member, 9L, "b", 2L, "member")));
        when(documents.permissionFor(eq(9L), anyLong())).thenThrow(new BizException(ErrorCode.NOT_FOUND));

        deliver(objectMapper.readTree("{\"type\":\"permission\",\"docId\":9}"));

        for (WebSocketSession session : List.of(owner, member)) {
            verify(sender).send(eq(session), argThat(node -> node.path("permission").asInt() == 0));
            verify(session).close(org.springframework.web.socket.CloseStatus.POLICY_VIOLATION);
        }
    }

    @Test
    void delayedDeletionNotificationDoesNotRevokeRestoredDocument() throws Exception {
        WebSocketSession restored = mock(WebSocketSession.class);
        when(registry.sessionsOf(9L)).thenReturn(List.of(
                new WsSessionRegistry.SessionInfo("restored", restored, 9L, "b", 2L, "member")));
        when(documents.permissionFor(9L, 2L)).thenReturn(2);

        deliver(objectMapper.readTree("{\"type\":\"permission\",\"docId\":9}"));

        verify(sender).send(eq(restored), argThat(node -> node.path("permission").asInt() == 2));
        verify(restored, never()).close(any());
    }

    private void deliver(JsonNode payload) {
        Message message = mock(Message.class);
        when(message.getBody()).thenReturn(objectMapper.createObjectNode().put("docId", 9)
                .put("instanceId", "remote").set("payload", payload).toString().getBytes(StandardCharsets.UTF_8));
        bus.onMessage(message, null);
    }
}
