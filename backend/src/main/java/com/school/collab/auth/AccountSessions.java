package com.school.collab.auth;

import com.school.collab.common.BizException;
import com.school.collab.common.ErrorCode;
import com.school.collab.common.JwtUtil;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.HexFormat;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.dao.DataAccessException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

@Service
public class AccountSessions {
    private final AccountRepository accounts;
    private final String secret;
    private final StringRedisTemplate redis;
    private final ApplicationEventPublisher events;

    public AccountSessions(AccountRepository accounts, @Value("${collab.jwt.secret}") String secret,
                           StringRedisTemplate redis, ApplicationEventPublisher events) {
        this.accounts = accounts;
        this.secret = secret;
        this.redis = redis;
        this.events = events;
    }

    public AccountRepository.Profile authenticate(String token) {
        return authenticateSession(token).profile();
    }

    public Authenticated authenticateSession(String token) {
        var claims = JwtUtil.parse(token, secret);
        var expiration = claims.getExpiration();
        if (expiration == null) throw unauthorized();
        long id = Long.parseLong(claims.getSubject());
        Object raw = claims.get("credentialVersion");
        // 兼容部署前的JWT：仅账号尚未改密(version=0)时接受缺省版本。
        if (raw != null && !(raw instanceof Integer || raw instanceof Long)) throw unauthorized();
        long version = raw == null ? 0 : ((Number) raw).longValue();
        if (id <= 0 || version < 0) throw unauthorized();
        var profile = accounts.profile(id).orElseThrow(this::unauthorized);
        String sessionKey = sessionKey(token);
        if (profile.credentialVersion() != version || expiration.getTime() <= System.currentTimeMillis()
                || !isActive(sessionKey)) {
            throw unauthorized();
        }
        return new Authenticated(profile, expiration.getTime(), sessionKey);
    }

    public boolean isCurrent(long id, long version, String sessionKey) {
        return accounts.isCurrent(id, version) && isActive(sessionKey);
    }

    public void revoke(String token) {
        var session = authenticateSession(token);
        long remaining = session.expiresAt() - System.currentTimeMillis();
        if (remaining > 0) {
            try {
                redis.opsForValue().set(session.sessionKey(), "1", Duration.ofMillis(remaining));
            } catch (DataAccessException exception) {
                throw new BizException(ErrorCode.SERVICE_UNAVAILABLE, "服务端暂时无法撤销登录，请稍后重试");
            }
        }
        events.publishEvent(new SessionRevoked(session.profile().id()));
    }

    private boolean isActive(String sessionKey) {
        if (sessionKey == null) return false;
        try {
            var revoked = redis.hasKey(sessionKey);
            if (revoked != null) return !revoked;
        } catch (DataAccessException ignored) { }
        throw new BizException(ErrorCode.SERVICE_UNAVAILABLE, "暂时无法校验登录状态，请稍后重试");
    }

    private static String sessionKey(String token) {
        // The verified header and claims identify both new and pre-jti tokens.
        // Ignore the signature segment so equivalent base64url encodings cannot change the key.
        String signedInput = token.substring(0, token.lastIndexOf('.'));
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(signedInput.getBytes(StandardCharsets.US_ASCII));
            return "collab:auth:revoked:" + HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 unavailable", impossible);
        }
    }

    private BizException unauthorized() {
        return new BizException(ErrorCode.UNAUTHORIZED);
    }

    public record Authenticated(AccountRepository.Profile profile, long expiresAt, String sessionKey) { }
    public record SessionRevoked(long userId) { }
}
