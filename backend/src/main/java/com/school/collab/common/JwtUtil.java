package com.school.collab.common;

import io.jsonwebtoken.Claims;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import javax.crypto.SecretKey;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.Date;

/** JWT通过签名与有效期验证；账号凭据版本由AccountSessions对照数据库校验。 */
public final class JwtUtil {
    private JwtUtil() { }
    public static String createToken(Long id,String username,String secret,Duration duration) {
        return createToken(id,username,username,secret,duration);
    }
    public static String createToken(Long id,String username,String nickname,String secret,Duration duration) {
        return buildToken(id,username,nickname,null,secret,duration);
    }
    public static String createToken(Long id,String username,String nickname,long version,String secret,Duration duration) {
        return buildToken(id,username,nickname,version,secret,duration);
    }
    private static String buildToken(Long id,String username,String nickname,Long version,String secret,Duration duration) {
        Instant now=Instant.now();
        var builder=Jwts.builder().subject(String.valueOf(id)).claim("username",username).claim("nickname",nickname)
                .issuedAt(Date.from(now)).expiration(Date.from(now.plus(duration)));
        if(version!=null) builder.claim("credentialVersion",version);
        return builder.signWith(signingKey(secret)).compact();
    }
    public static Claims parse(String token,String secret) {
        return Jwts.parser().verifyWith(signingKey(secret)).build().parseSignedClaims(token).getPayload();
    }
    private static SecretKey signingKey(String secret) { return Keys.hmacShaKeyFor(secret.getBytes(StandardCharsets.UTF_8)); }
}
