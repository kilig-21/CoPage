package com.school.collab.collab.ws;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.collab.service.DocRevService;
import com.school.collab.collab.presence.RedisPresenceStore;
import com.school.collab.common.BizException;
import com.school.collab.common.ErrorCode;
import com.school.collab.document.DocumentService;
import com.school.collab.collab.store.VersionedOperation;
import com.school.collab.ot.Delta;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.CloseStatus;

import java.util.Map;
import java.util.List;
import java.util.function.Consumer;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

class CollabWebSocketHandlerTest {
    private final ObjectMapper objectMapper = new ObjectMapper();
    private final DocRevService revisions = mock(DocRevService.class);
    private final DocumentService documents = mock(DocumentService.class);
    private final WsSessionRegistry registry = mock(WsSessionRegistry.class);
    private final WsSender sender = mock(WsSender.class);
    private final CollabEventBus eventBus = mock(CollabEventBus.class);
    private final RedisPresenceStore presence = mock(RedisPresenceStore.class);
    private final CollabWebSocketHandler handler =
            new CollabWebSocketHandler(
                    objectMapper, revisions, documents, registry, sender, eventBus, presence);

    @Test
    void joinRegistersAndSendsCatchupInsideTheServiceCallback() throws Exception {
        WebSocketSession session = mock(WebSocketSession.class);
        when(session.getAttributes()).thenReturn(Map.of(
                WsHandshakeInterceptor.USER_ID, 2L, WsHandshakeInterceptor.NICKNAME, "testB"));
        WsSessionRegistry.SessionInfo info = new WsSessionRegistry.SessionInfo(
                "session-1", session, 5L, "test-client", 2L, "testB");
        when(registry.register(session, 5L, "test-client", 2L, "testB")).thenReturn(info);
        doAnswer(invocation -> {
            verifyNoInteractions(registry);
            DocRevService.PendingOperation pending = invocation.getArgument(4);
            assertEquals("op-1", pending.opId());
            Consumer<DocRevService.JoinState> callback = invocation.getArgument(5);
            callback.accept(new DocRevService.JoinState(1, new Delta().insert("X\n"), true,
                    List.of(new VersionedOperation(1, new Delta().insert("X"))), 1L));
            verify(registry).register(session, 5L, "test-client", 2L, "testB");
            verify(sender).send(eq(session), any());
            return null;
        }).when(revisions).joinState(eq(5L), eq(0L), eq(2L), eq("test-client"), any(), any());

        handler.handleTextMessage(session, new TextMessage("""
                {"type":"join","docId":5,"clientId":"test-client","lastRevision":0,
                 "syncId":"sync-1","pendingOpId":"op-1","pendingBaseRevision":0,
                 "pendingOp":{"ops":[{"insert":"X"}]}}
                """));

        ArgumentCaptor<JsonNode> response = ArgumentCaptor.forClass(JsonNode.class);
        verify(sender).send(eq(session), response.capture());
        JsonNode sync = response.getValue();
        assertEquals("sync", sync.path("type").asText());
        assertEquals("sync-1", sync.path("syncId").asText());
        assertEquals(true, sync.path("historyComplete").asBoolean());
        assertEquals(1, sync.path("pendingCommittedRevision").asLong());
        assertEquals("X", sync.path("history").get(0).path("op").path("ops").get(0).path("insert").asText());
    }

    @Test
    void unauthorizedUserCannotJoinDocument() throws Exception {
        WebSocketSession session = mock(WebSocketSession.class);
        when(session.getAttributes()).thenReturn(Map.of(
                WsHandshakeInterceptor.USER_ID, 2L,
                WsHandshakeInterceptor.NICKNAME, "测试用户 B"));
        when(documents.permissionFor(5L, 2L)).thenThrow(new BizException(ErrorCode.FORBIDDEN));

        handler.handleTextMessage(session,
                new TextMessage("{\"type\":\"join\",\"docId\":5,\"clientId\":\"test-client\",\"lastRevision\":0}"));

        ArgumentCaptor<JsonNode> response = ArgumentCaptor.forClass(JsonNode.class);
        verify(sender).send(eq(session), response.capture());
        assertEquals("error", response.getValue().get("type").asText());
        assertEquals(403, response.getValue().get("code").asInt());
        verify(registry, never()).register(any(), anyLong(), anyString(), anyLong(), anyString());
    }

    @Test
    void readOnlyCollaboratorCannotSubmitOperation() throws Exception {
        WebSocketSession session = mock(WebSocketSession.class);
        WsSessionRegistry.SessionInfo info = new WsSessionRegistry.SessionInfo(
                "session-1", session, 5L, "test-client", 2L, "testB");
        when(registry.require(session)).thenReturn(info);
        when(documents.permissionFor(5L, 2L)).thenReturn(1);

        handler.handleTextMessage(session,
                new TextMessage("{\"type\":\"op\",\"docId\":5,\"clientId\":\"test-client\","
                        + "\"baseRevision\":0,\"op\":{\"ops\":[{\"insert\":\"X\"}]}}"));

        ArgumentCaptor<JsonNode> response = ArgumentCaptor.forClass(JsonNode.class);
        verify(sender).send(eq(session), response.capture());
        assertEquals(403, response.getValue().get("code").asInt());
        verifyNoInteractions(revisions);
    }

    @Test
    void repeatedOperationOnlyResendsTheOriginalAck() throws Exception {
        WebSocketSession session = mock(WebSocketSession.class);
        WsSessionRegistry.SessionInfo info = new WsSessionRegistry.SessionInfo(
                "session-1", session, 5L, "test-client", 2L, "testB");
        when(registry.require(session)).thenReturn(info);
        when(documents.permissionFor(5L, 2L)).thenReturn(2);
        when(revisions.commit(eq(5L), eq(0L), any(), eq(2L), eq("test-client"),
                eq("op-1"), any())).thenReturn(new DocRevService.CommitResult(3, null, false));

        handler.handleTextMessage(session,
                new TextMessage("{\"type\":\"op\",\"docId\":5,\"clientId\":\"test-client\","
                        + "\"opId\":\"op-1\",\"baseRevision\":0,"
                        + "\"op\":{\"ops\":[{\"insert\":\"X\"}]}}"));

        ArgumentCaptor<JsonNode> response = ArgumentCaptor.forClass(JsonNode.class);
        verify(sender).send(eq(session), response.capture());
        assertEquals("ack", response.getValue().get("type").asText());
        assertEquals("op-1", response.getValue().get("opId").asText());
        assertEquals(3, response.getValue().get("revision").asInt());
        verifyNoInteractions(eventBus);
    }

    @Test
    void cursorUsesAuthenticatedNicknameAndSupportsHide() throws Exception {
        WebSocketSession session = mock(WebSocketSession.class);
        WsSessionRegistry.SessionInfo info = new WsSessionRegistry.SessionInfo(
                "session-1", session, 5L, "test-client", 2L, "测试用户 B");
        when(registry.require(session)).thenReturn(info);

        handler.handleTextMessage(session, new TextMessage("""
                {"type":"cursor","docId":5,"index":3,"length":1,"visible":false}
                """));

        ArgumentCaptor<JsonNode> message = ArgumentCaptor.forClass(JsonNode.class);
        verify(eventBus).publish(eq(5L), eq("session-1"), message.capture());
        assertEquals("test-client", message.getValue().path("clientId").asText());
        assertEquals("测试用户 B", message.getValue().path("nickname").asText());
        assertEquals(false, message.getValue().path("visible").asBoolean());
        assertEquals(3, message.getValue().path("index").asInt());
        assertEquals(1, message.getValue().path("length").asInt());
    }

    @Test
    void leavingSessionBroadcastsCursorHide() {
        WebSocketSession session = mock(WebSocketSession.class);
        WsSessionRegistry.SessionInfo info = new WsSessionRegistry.SessionInfo(
                "session-1", session, 5L, "test-client", 2L, "测试用户 B");
        when(registry.current(session)).thenReturn(info);

        handler.afterConnectionClosed(session, CloseStatus.NORMAL);

        ArgumentCaptor<JsonNode> messages = ArgumentCaptor.forClass(JsonNode.class);
        verify(eventBus).publish(eq(5L), eq("session-1"), messages.capture());
        assertEquals("cursor", messages.getValue().path("type").asText());
        assertEquals(false, messages.getValue().path("visible").asBoolean());
        assertEquals("test-client", messages.getValue().path("clientId").asText());
        verify(presence).leave(info, eventBus.instanceId());
    }
}
