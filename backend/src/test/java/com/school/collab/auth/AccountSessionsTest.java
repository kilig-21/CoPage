package com.school.collab.auth;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.common.BizException;
import com.school.collab.common.JwtUtil;
import com.school.collab.common.UserContext;
import com.school.collab.config.interceptor.JwtInterceptor;
import com.school.collab.collab.ws.WsHandshakeInterceptor;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.ValueOperations;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.http.server.ServletServerHttpRequest;
import org.springframework.http.server.ServletServerHttpResponse;
import java.time.Duration;
import java.util.HashMap;
import java.util.Optional;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class AccountSessionsTest {
    private static final String SECRET="test-secret-longer-than-thirty-two-bytes";
    private final AccountRepository accounts=mock(AccountRepository.class);
    private final StringRedisTemplate redis = mock(StringRedisTemplate.class);
    private final ApplicationEventPublisher events = mock(ApplicationEventPublisher.class);
    private final AccountSessions sessions=new AccountSessions(accounts, SECRET, redis, events);
    private void version(long value) {
        when(accounts.profile(5L)).thenReturn(Optional.of(new AccountRepository.Profile(5,"owner","New nickname",null,value)));
    }
    @Test void handshakeRetainsSignedExpirationWithoutRetainingToken() {
        version(0);
        String token = JwtUtil.createToken(5L, "owner", SECRET, Duration.ofHours(1));
        long expected = JwtUtil.parse(token, SECRET).getExpiration().getTime();
        assertEquals(expected, sessions.authenticateSession(token).expiresAt());
        var request = new MockHttpServletRequest("GET", "/ws/collab");
        request.addHeader("Sec-WebSocket-Protocol", "copage.v1, bearer." + token);
        var attributes = new HashMap<String, Object>();
        assertTrue(new WsHandshakeInterceptor(sessions).beforeHandshake(new ServletServerHttpRequest(request),
                new ServletServerHttpResponse(new MockHttpServletResponse()), null, attributes));
        assertEquals(expected, attributes.get(WsHandshakeInterceptor.TOKEN_EXPIRES_AT));
        assertFalse(attributes.containsValue(token));
    }

    @Test void tokenWithoutExpirationIsRejectedBeforeAccountLookup() {
        String token = io.jsonwebtoken.Jwts.builder().subject("5")
                .signWith(io.jsonwebtoken.security.Keys.hmacShaKeyFor(SECRET.getBytes(java.nio.charset.StandardCharsets.UTF_8)))
                .compact();
        var error = assertThrows(BizException.class, () -> sessions.authenticate(token));
        assertEquals(com.school.collab.common.ErrorCode.UNAUTHORIZED, error.getErrorCode());
        verifyNoInteractions(accounts);
    }
    @Test void legacyTokenIsAcceptedOnlyUntilFirstPasswordChange() {
        String legacy=JwtUtil.createToken(5L,"owner","Old nickname",SECRET,Duration.ofHours(1));
        version(0);assertEquals("New nickname",sessions.authenticate(legacy).nickname());
        version(1);assertThrows(BizException.class,()->sessions.authenticate(legacy));
    }
    @Test void oldCredentialVersionRejectedAndNewVersionUsesCurrentDatabaseProfile() {
        String old=JwtUtil.createToken(5L,"owner","Old",3,SECRET,Duration.ofHours(1));
        String current=JwtUtil.createToken(5L,"owner","Old",4,SECRET,Duration.ofHours(1));
        version(4);assertThrows(BizException.class,()->sessions.authenticate(old));
        assertEquals("New nickname",sessions.authenticate(current).nickname());
        when(accounts.profile(5L)).thenReturn(Optional.empty());
        assertThrows(BizException.class,()->sessions.authenticate(current));
    }
    @Test void credentialRevocationIsAppliedToHttpAndWebsocketHandshake() throws Exception {
        version(4);String old=JwtUtil.createToken(5L,"owner","Old",3,SECRET,Duration.ofHours(1));
        var request=new MockHttpServletRequest("GET","/api/doc/list");request.addHeader("Authorization","Bearer "+old);
        var response=new MockHttpServletResponse();UserContext.set(99L,"stale");
        assertFalse(new JwtInterceptor(sessions,new ObjectMapper()).preHandle(request,response,new Object()));
        assertEquals(401,response.getStatus());assertNull(UserContext.getUserId());
        request.addHeader("Sec-WebSocket-Protocol", "copage.v1, bearer."+old);response=new MockHttpServletResponse();
        assertFalse(new WsHandshakeInterceptor(sessions).beforeHandshake(new ServletServerHttpRequest(request),
                new ServletServerHttpResponse(response),null,new HashMap<>()));
        assertEquals(401,response.getStatus());
    }
    @Test void databaseOutageDoesNotBecomeUnauthorizedAndHandshakeReturnsRetryableFailure() throws Exception {
        when(accounts.profile(5L)).thenThrow(new DataAccessResourceFailureException("synthetic unavailable"));
        String token=JwtUtil.createToken(5L,"owner",SECRET,Duration.ofHours(1));
        var request=new MockHttpServletRequest("GET","/api/doc/list");request.addHeader("Authorization","Bearer "+token);
        var response=new MockHttpServletResponse();
        var httpResponse = response;
        assertThrows(DataAccessResourceFailureException.class,()->new JwtInterceptor(sessions,new ObjectMapper()).preHandle(request,httpResponse,new Object()));
        assertNotEquals(401,response.getStatus());assertNull(UserContext.getUserId());
        request.addHeader("Sec-WebSocket-Protocol", "copage.v1, bearer."+token);response=new MockHttpServletResponse();
        assertFalse(new WsHandshakeInterceptor(sessions).beforeHandshake(new ServletServerHttpRequest(request),
                new ServletServerHttpResponse(response),null,new HashMap<>()));
        assertEquals(503,response.getStatus());
    }

    @Test
    @SuppressWarnings("unchecked")
    void revokesOnlyThePresentedTokenForItsRemainingLifetime() throws Exception {
        version(0);
        String revoked = JwtUtil.createToken(5L, "owner", SECRET, Duration.ofMinutes(10));
        String other = JwtUtil.createToken(5L, "owner", SECRET, Duration.ofMinutes(10));
        assertNotEquals(revoked, other);
        var session = sessions.authenticateSession(revoked);
        assertFalse(session.sessionKey().contains(revoked));
        var values = (ValueOperations<String, String>) mock(ValueOperations.class);
        when(redis.opsForValue()).thenReturn(values);

        sessions.revoke(revoked);
        var ttl = ArgumentCaptor.forClass(Duration.class);
        verify(values).set(eq(session.sessionKey()), eq("1"), ttl.capture());
        assertTrue(ttl.getValue().toSeconds() >= 595 && ttl.getValue().toSeconds() <= 600);
        verify(events).publishEvent(new AccountSessions.SessionRevoked(5));
        when(redis.hasKey(session.sessionKey())).thenReturn(true);

        var request = new MockHttpServletRequest("GET", "/api/doc/list");
        request.addHeader("Authorization", "Bearer " + revoked);
        var http = new MockHttpServletResponse();
        assertFalse(new JwtInterceptor(sessions, new ObjectMapper()).preHandle(request, http, new Object()));
        assertEquals(401, http.getStatus());

        var upgrade = new MockHttpServletRequest("GET", "/ws/collab");
        upgrade.addHeader("Sec-WebSocket-Protocol", "copage.v1, bearer." + revoked);
        var rejected = new MockHttpServletResponse();
        assertFalse(new WsHandshakeInterceptor(sessions).beforeHandshake(new ServletServerHttpRequest(upgrade),
                new ServletServerHttpResponse(rejected), null, new HashMap<>()));
        assertEquals(401, rejected.getStatus());
        assertEquals(5, sessions.authenticate(other).id());
    }

    @Test
    void redisFailureDoesNotPermitAValidBearer() {
        version(0);
        when(redis.hasKey(anyString())).thenThrow(new DataAccessResourceFailureException("unavailable"));
        var token = JwtUtil.createToken(5L, "owner", SECRET, Duration.ofMinutes(10));
        var failure = assertThrows(BizException.class, () -> sessions.authenticate(token));
        assertEquals(com.school.collab.common.ErrorCode.SERVICE_UNAVAILABLE, failure.getErrorCode());
        verifyNoInteractions(events);
    }
}
