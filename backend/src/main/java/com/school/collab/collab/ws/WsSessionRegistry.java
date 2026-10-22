package com.school.collab.collab.ws;

import com.school.collab.collab.CollabException;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;
import org.springframework.web.socket.handler.WebSocketSessionDecorator;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

/** 文档到会话的本地注册表；后续 Redis 订阅者也复用它向本机用户转发消息。 */
@Component
public class WsSessionRegistry {

    private static final int SEND_TIME_LIMIT_MS = 10_000;
    private static final int SEND_BUFFER_LIMIT_BYTES = 512 * 1024;
    private static final String SEND_SESSION_ATTRIBUTE = WsSessionRegistry.class.getName() + ".sendSession";

    private final ConcurrentMap<String, SessionInfo> bySessionId = new ConcurrentHashMap<>();
    private final ConcurrentMap<Long, ConcurrentMap<String, SessionInfo>> byDocumentId = new ConcurrentHashMap<>();

    /** 同一连接只保留一个发送队列；短锁仅用于初始化，真正发送不得持有此锁。 */
    static ConcurrentWebSocketSessionDecorator sendSessionFor(WebSocketSession session) {
        WebSocketSession raw = WebSocketSessionDecorator.unwrap(session);
        synchronized (raw) {
            Object cached = raw.getAttributes().get(SEND_SESSION_ATTRIBUTE);
            if (cached != null) {
                if (cached instanceof ConcurrentWebSocketSessionDecorator safe
                        && WebSocketSessionDecorator.unwrap(safe) == raw) return safe;
                throw new IllegalStateException("发送队列与当前底层连接不一致");
            }
            // 首次已有显式装饰器时保留其限额，否则使用统一默认值。
            var safe = session instanceof ConcurrentWebSocketSessionDecorator supplied ? supplied
                    : new ConcurrentWebSocketSessionDecorator(raw, SEND_TIME_LIMIT_MS, SEND_BUFFER_LIMIT_BYTES);
            raw.getAttributes().put(SEND_SESSION_ATTRIBUTE, safe);
            return safe;
        }
    }

    public SessionInfo register(WebSocketSession rawSession, long docId, String clientId, long userId, String nickname) {
        unregister(rawSession);
        WebSocketSession safeSession = sendSessionFor(rawSession);
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

    public List<SessionInfo> sessionsOfUser(long userId) {
        return bySessionId.values().stream().filter(info -> info.userId() == userId).toList();
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
