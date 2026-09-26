package com.school.collab.collab.ws;

import com.school.collab.common.JwtUtil;
import io.jsonwebtoken.Claims;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.stereotype.Component;
import org.springframework.util.MultiValueMap;
import org.springframework.web.util.UriComponentsBuilder;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.HandshakeInterceptor;

import java.util.Map;

/** 浏览器 WebSocket 不能自定义 Authorization，因此 JWT 固定从 ?token= 读取。 */
@Component
public class WsHandshakeInterceptor implements HandshakeInterceptor {

    public static final String USER_ID = "ws.userId";
    public static final String USERNAME = "ws.username";
    public static final String NICKNAME = "ws.nickname";

    private final String jwtSecret;

    public WsHandshakeInterceptor(@Value("${collab.jwt.secret}") String jwtSecret) {
        this.jwtSecret = jwtSecret;
    }

    @Override
    public boolean beforeHandshake(
            ServerHttpRequest request,
            ServerHttpResponse response,
            WebSocketHandler wsHandler,
            Map<String, Object> attributes
    ) {
        MultiValueMap<String, String> query = UriComponentsBuilder.fromUri(request.getURI())
                .build()
                .getQueryParams();
        String token = query.getFirst("token");
        if (token == null || token.isBlank()) {
            response.setStatusCode(HttpStatus.UNAUTHORIZED);
            return false;
        }

        try {
            Claims claims = JwtUtil.parse(token, jwtSecret);
            attributes.put(USER_ID, Long.parseLong(claims.getSubject()));
            attributes.put(USERNAME, claims.get("username", String.class));
            String nickname = claims.get("nickname", String.class);
            attributes.put(NICKNAME, nickname == null ? claims.get("username", String.class) : nickname);
            return true;
        } catch (Exception exception) {
            response.setStatusCode(HttpStatus.UNAUTHORIZED);
            return false;
        }
    }

    @Override
    public void afterHandshake(
            ServerHttpRequest request,
            ServerHttpResponse response,
            WebSocketHandler wsHandler,
            Exception exception
    ) {
        // no-op
    }
}
