package com.school.collab.auth;

import com.school.collab.common.BizException;
import com.school.collab.common.ErrorCode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.RedisScript;
import org.springframework.mock.web.MockHttpServletRequest;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class AuthRateLimiterTest {
    private final StringRedisTemplate redis = mock(StringRedisTemplate.class);

    @BeforeEach
    void allowRedisChecks() {
        when(redis.execute(any(RedisScript.class), anyList(), any(Object[].class))).thenReturn(0L);
    }

    @Test
    void directRequestsIgnoreForwardedHeadersAndCanonicalizeTheAccount() {
        var limiter = limiter(List.of());
        var direct = request("192.0.2.10", null);
        String previous = limiter.allowLogin(direct, "Äccount");
        assertEquals(previous, limiter.allowLogin(request("192.0.2.10", "192.0.2.11"), " account "));
        assertNotEquals(previous, limiter.allowLogin(request("192.0.2.11", null), "account"));
        assertNotEquals(previous, limiter.allowLogin(direct, "different"));
        assertFalse(previous.contains("192.0.2.10"));
        assertFalse(previous.contains("account"));
    }

    @Test
    void exactTrustedProxyAcceptsOneLiteralButRejectsAmbiguousHeaders() {
        var limiter = limiter(List.of("::1"));
        String peer = limiter.allowLogin(request("0:0:0:0:0:0:0:1", null), "account");
        String forwarded = limiter.allowLogin(request("::1", "192.0.2.11"), "account");
        assertEquals(limiter.allowLogin(request("192.0.2.11", null), "account"), forwarded);
        assertNotEquals(peer, forwarded);
        assertEquals(peer, limiter.allowLogin(request("::1", "192.0.2.11, 192.0.2.12"), "account"));
        var duplicate = request("::1", "192.0.2.11");
        duplicate.addHeader("X-Forwarded-For", "192.0.2.12");
        assertEquals(peer, limiter.allowLogin(duplicate, "account"));
        assertThrows(IllegalArgumentException.class, () -> limiter(List.of("192.0.2.0/24")));
    }

    @Test
    void redisFailureReturnsServiceUnavailableBeforeCallingAuthentication() {
        when(redis.execute(any(RedisScript.class), anyList(), any(Object[].class)))
                .thenThrow(new DataAccessResourceFailureException("synthetic failure"));
        var failure = assertThrows(BizException.class, () -> limiter(List.of())
                .allowLogin(request("192.0.2.10", null), "account"));
        assertEquals(ErrorCode.SERVICE_UNAVAILABLE, failure.getErrorCode());
    }

    private AuthRateLimiter limiter(List<String> proxies) {
        var window = new AuthRateLimiter.Window(20, 5, 60);
        return new AuthRateLimiter(redis, new AuthRateLimiter.Settings(window, window, 3, 60, 10, proxies));
    }

    private MockHttpServletRequest request(String peer, String forwarded) {
        var request = new MockHttpServletRequest();
        request.setRemoteAddr(peer);
        if (forwarded != null) request.addHeader("X-Forwarded-For", forwarded);
        return request;
    }
}
