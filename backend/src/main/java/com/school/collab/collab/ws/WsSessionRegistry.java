package com.school.collab.collab.ws;

import com.school.collab.collab.CollabException;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

/** 文档到会话的本地注册表；后续 Redis 订阅者也复用它向本机用户转发消息。 */
@Component
public class WsSessionRegistry {

    private static final int SEND_TIME_LIMIT_MS = 10_000;
    private static final int SEND_BUFFER_LIMIT_BYTES = 512 * 1024;

    private final ConcurrentMap<String, SessionInfo> bySessionId = new ConcurrentHashMap<>();
    private final ConcurrentMap<Long, ConcurrentMap<String, SessionInfo>> byDocumentId = new ConcurrentHashMap<>();

    public SessionInfo register(WebSocketSession rawSession, long docId, String clientId, long userId, String nickname) {
        unregister(rawSession);
        WebSocketSession safeSession = new ConcurrentWebSocketSessionDecorator(
                rawSession, SEND_TIME_LIMIT_MS, SEND_BUFFER_LIMIT_BYTES
        );
        SessionInfo info = new SessionInfo(rawSession.getId(), safeSession, docId, clientId, userId, nickname);
        bySessionId.put(info.sessionId(), info);
        byDocumentId.computeIfAbsent(docId, ignored -> new ConcurrentHashMap<>()).put(info.sessionId(), info);
        return info;
    }

    public SessionInfo require(WebSocketSession session) {
        SessionInfo info = current(session);
        if (info == null) {
            throw new CollabException(400, "请先发送 join 消息");
        }
        return info;
    }

    public SessionInfo current(WebSocketSession session) {
        return bySessionId.get(session.getId());
    }

    public List<SessionInfo> sessionsOf(long docId) {
        ConcurrentMap<String, SessionInfo> sessions = byDocumentId.get(docId);
        return sessions == null ? List.of() : new ArrayList<>(sessions.values());
    }

    public void unregister(WebSocketSession session) {
        SessionInfo old = bySessionId.remove(session.getId());
        if (old == null) {
            return;
        }
        byDocumentId.computeIfPresent(old.docId(), (ignored, sessions) -> {
            sessions.remove(old.sessionId());
            return sessions.isEmpty() ? null : sessions;
        });
    }

    public record SessionInfo(
            String sessionId,
            WebSocketSession session,
            long docId,
            String clientId,
            long userId,
            String nickname
    ) {
    }
}
