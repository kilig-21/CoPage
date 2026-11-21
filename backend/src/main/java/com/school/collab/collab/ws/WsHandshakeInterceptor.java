package com.school.collab.collab.ws;

import com.school.collab.auth.AccountSessions;
import com.school.collab.common.BizException;
import com.school.collab.common.ErrorCode;
import io.jsonwebtoken.JwtException;
import org.springframework.dao.DataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.server.HandshakeInterceptor;
import org.springframework.web.socket.WebSocketHttpHeaders;
import java.util.Map;

@Component
public class WsHandshakeInterceptor implements HandshakeInterceptor {
    public static final String PROTOCOL = "copage.v1";
    private static final String BEARER_PREFIX = "bearer.";
    public static final String USER_ID="ws.userId", USERNAME="ws.username", NICKNAME="ws.nickname";
    public static final String CREDENTIAL_VERSION="ws.credentialVersion";
    public static final String TOKEN_EXPIRES_AT = "ws.tokenExpiresAt";
    public static final String SESSION_KEY = "ws.sessionKey";
    private final AccountSessions sessions;
    public WsHandshakeInterceptor(AccountSessions sessions) { this.sessions=sessions; }
    @Override
    public boolean beforeHandshake(ServerHttpRequest request,ServerHttpResponse response,
                                   WebSocketHandler handler,Map<String,Object> attributes) {
        var protocols = new WebSocketHttpHeaders(request.getHeaders()).getSecWebSocketProtocol();
        if (request.getURI().getRawQuery() != null || protocols.size() != 2 || !PROTOCOL.equals(protocols.getFirst())
                || !protocols.getLast().startsWith(BEARER_PREFIX)) {
            response.setStatusCode(HttpStatus.UNAUTHORIZED);
            return false;
        }
        String token = protocols.getLast().substring(BEARER_PREFIX.length());
        try {
            var authenticated = sessions.authenticateSession(token);
            var profile = authenticated.profile();
            attributes.put(USER_ID,profile.id());attributes.put(USERNAME,profile.username());
            attributes.put(NICKNAME,profile.nickname()==null||profile.nickname().isBlank()?profile.username():profile.nickname());
            attributes.put(CREDENTIAL_VERSION,profile.credentialVersion());
            attributes.put(TOKEN_EXPIRES_AT, authenticated.expiresAt());
            attributes.put(SESSION_KEY, authenticated.sessionKey());
            return true;
        } catch(DataAccessException exception) { response.setStatusCode(HttpStatus.SERVICE_UNAVAILABLE);return false; }
        catch (BizException exception) {
            response.setStatusCode(exception.getErrorCode() == ErrorCode.SERVICE_UNAVAILABLE
                    ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.UNAUTHORIZED);
            return false;
        }
        catch(JwtException | IllegalArgumentException exception) { response.setStatusCode(HttpStatus.UNAUTHORIZED);return false; }
    }
    public static boolean tokenUnexpired(WebSocketSession session) {
        Object value = session.getAttributes().get(TOKEN_EXPIRES_AT);
        return value instanceof Long expiresAt && expiresAt > System.currentTimeMillis();
    }

    public static long credentialVersion(WebSocketSession session) {
        Object raw=session.getAttributes().get(CREDENTIAL_VERSION);
        return raw==null?0:raw instanceof Long||raw instanceof Integer?((Number)raw).longValue():-1;
    }

    static boolean sessionCurrent(WebSocketSession session, long userId, AccountSessions accounts) {
        Object key = session.getAttributes().get(SESSION_KEY);
        return key instanceof String sessionKey && tokenUnexpired(session)
                && accounts.isCurrent(userId, credentialVersion(session), sessionKey);
    }
    @Override
    public void afterHandshake(ServerHttpRequest request,ServerHttpResponse response,WebSocketHandler handler,Exception exception) { }
}
