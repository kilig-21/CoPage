package com.school.collab.common;

import io.jsonwebtoken.Claims;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import javax.crypto.SecretKey;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.Date;

/**
 * JWT 签发与解析工具。WebSocket 鉴权通过 ?token= 传入，HTTP 使用 Bearer token。
 */
public final class JwtUtil {
    private JwtUtil() {
    }

    public static String createToken(Long userId, String username, String secret, Duration expiresIn) {
        Instant now = Instant.now();
        return Jwts.builder()
                .subject(String.valueOf(userId))
                .claim("username", username)
                .issuedAt(Date.from(now))
                .expiration(Date.from(now.plus(expiresIn)))
                .signWith(signingKey(secret))
                .compact();
    }

    public static Claims parse(String token, String secret) {
        return Jwts.parser()
                .verifyWith(signingKey(secret))
                .build()
                .parseSignedClaims(token)
                .getPayload();
    }

    private static SecretKey signingKey(String secret) {
        return Keys.hmacShaKeyFor(secret.getBytes(StandardCharsets.UTF_8));
    }
}
