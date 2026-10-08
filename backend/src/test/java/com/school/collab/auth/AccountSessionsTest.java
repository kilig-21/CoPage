package com.school.collab.auth;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.common.BizException;
import com.school.collab.common.JwtUtil;
import com.school.collab.common.UserContext;
import com.school.collab.config.interceptor.JwtInterceptor;
import com.school.collab.collab.ws.WsHandshakeInterceptor;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataAccessResourceFailureException;
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
    private final AccountSessions sessions=new AccountSessions(accounts,SECRET);
    private void version(long value) {
        when(accounts.profile(5L)).thenReturn(Optional.of(new AccountRepository.Profile(5,"owner","New nickname",null,value)));
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
        request.setQueryString("token="+old);response=new MockHttpServletResponse();
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
        request.setQueryString("token="+token);response=new MockHttpServletResponse();
        assertFalse(new WsHandshakeInterceptor(sessions).beforeHandshake(new ServletServerHttpRequest(request),
                new ServletServerHttpResponse(response),null,new HashMap<>()));
        assertEquals(503,response.getStatus());
    }
}
