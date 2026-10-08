package com.school.collab.collab.ws;

import com.school.collab.auth.AccountSessions;
import com.school.collab.common.BizException;
import io.jsonwebtoken.JwtException;
import org.springframework.dao.DataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.server.HandshakeInterceptor;
import org.springframework.web.util.UriComponentsBuilder;
import java.util.Map;

@Component
public class WsHandshakeInterceptor implements HandshakeInterceptor {
    public static final String USER_ID="ws.userId", USERNAME="ws.username", NICKNAME="ws.nickname";
    public static final String CREDENTIAL_VERSION="ws.credentialVersion";
    private final AccountSessions sessions;
    public WsHandshakeInterceptor(AccountSessions sessions) { this.sessions=sessions; }
    @Override
    public boolean beforeHandshake(ServerHttpRequest request,ServerHttpResponse response,
                                   WebSocketHandler handler,Map<String,Object> attributes) {
        String token=UriComponentsBuilder.fromUri(request.getURI()).build().getQueryParams().getFirst("token");
        if(token==null || token.isBlank()) { response.setStatusCode(HttpStatus.UNAUTHORIZED);return false; }
        try {
            var profile=sessions.authenticate(token);
            attributes.put(USER_ID,profile.id());attributes.put(USERNAME,profile.username());
            attributes.put(NICKNAME,profile.nickname()==null||profile.nickname().isBlank()?profile.username():profile.nickname());
            attributes.put(CREDENTIAL_VERSION,profile.credentialVersion());
            return true;
        } catch(DataAccessException exception) { response.setStatusCode(HttpStatus.SERVICE_UNAVAILABLE);return false; }
        catch(BizException | JwtException | IllegalArgumentException exception) { response.setStatusCode(HttpStatus.UNAUTHORIZED);return false; }
    }
    public static long credentialVersion(WebSocketSession session) {
        Object raw=session.getAttributes().get(CREDENTIAL_VERSION);
        return raw==null?0:raw instanceof Long||raw instanceof Integer?((Number)raw).longValue():-1;
    }
    @Override
    public void afterHandshake(ServerHttpRequest request,ServerHttpResponse response,WebSocketHandler handler,Exception exception) { }
}
