package com.school.collab.collab.ws;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.collab.service.DocRevService;
import com.school.collab.common.BizException;
import com.school.collab.common.ErrorCode;
import com.school.collab.document.DocumentService;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

class CollabWebSocketHandlerTest {
    private final ObjectMapper objectMapper = new ObjectMapper();
    private final DocRevService revisions = mock(DocRevService.class);
    private final DocumentService documents = mock(DocumentService.class);
    private final WsSessionRegistry registry = mock(WsSessionRegistry.class);
    private final WsSender sender = mock(WsSender.class);
    private final CollabWebSocketHandler handler =
            new CollabWebSocketHandler(objectMapper, revisions, documents, registry, sender);

    @Test
    void unauthorizedUserCannotJoinDocument() throws Exception {
        WebSocketSession session = mock(WebSocketSession.class);
        when(session.getAttributes()).thenReturn(Map.of(
                WsHandshakeInterceptor.USER_ID, 2L,
                WsHandshakeInterceptor.USERNAME, "testB"));
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
}
