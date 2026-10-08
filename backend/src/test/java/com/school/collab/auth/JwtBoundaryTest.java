package com.school.collab.auth;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.collab.ws.WsHandshakeInterceptor;
import com.school.collab.common.JwtUtil;
import com.school.collab.common.UserContext;
import com.school.collab.config.interceptor.JwtInterceptor;
import org.junit.jupiter.api.Test;
import org.springframework.http.server.ServletServerHttpRequest;
import org.springframework.http.server.ServletServerHttpResponse;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import java.time.Duration;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import static org.mockito.Mockito.*;

import static org.junit.jupiter.api.Assertions.*;

class JwtBoundaryTest {
    private static final String SECRET = "test-secret-longer-than-thirty-two-bytes";

    private AccountSessions sessions() {
        AccountRepository accounts=mock(AccountRepository.class);
        when(accounts.profile(12L)).thenReturn(Optional.of(new AccountRepository.Profile(12,"alice","Alice",null,0)));
        when(accounts.profile(13L)).thenReturn(Optional.of(new AccountRepository.Profile(13,"bob","Bob",null,0)));
        return new AccountSessions(accounts,SECRET);
    }

    @Test
    void httpRequiresBearerAndClearsRequestContext() throws Exception {
        JwtInterceptor interceptor = new JwtInterceptor(sessions(), new ObjectMapper());
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/api/doc/list");
        MockHttpServletResponse response = new MockHttpServletResponse();
        assertFalse(interceptor.preHandle(request, response, new Object()));
        assertEquals(401, response.getStatus());

        request.addHeader("Authorization", "Bearer " +
                JwtUtil.createToken(12L, "alice", SECRET, Duration.ofHours(1)));
        response = new MockHttpServletResponse();
        assertTrue(interceptor.preHandle(request, response, new Object()));
        assertEquals(12L, UserContext.getUserId());
        interceptor.afterCompletion(request, response, new Object(), null);
        assertNull(UserContext.getUserId());
    }

    @Test
    void websocketRequiresValidQueryToken() {
        WsHandshakeInterceptor interceptor = new WsHandshakeInterceptor(sessions());
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/ws/collab");
        MockHttpServletResponse response = new MockHttpServletResponse();
        assertFalse(interceptor.beforeHandshake(new ServletServerHttpRequest(request),
                new ServletServerHttpResponse(response), null, new HashMap<>()));
        assertEquals(401, response.getStatus());

        request.setQueryString("token=not-a-jwt");
        response = new MockHttpServletResponse();
        assertFalse(interceptor.beforeHandshake(new ServletServerHttpRequest(request),
                new ServletServerHttpResponse(response), null, new HashMap<>()));
        assertEquals(401, response.getStatus());

        request.setQueryString("token=" +
                JwtUtil.createToken(13L, "bob", SECRET, Duration.ofHours(1)));
        response = new MockHttpServletResponse();
        Map<String, Object> attributes = new HashMap<>();
        assertTrue(interceptor.beforeHandshake(new ServletServerHttpRequest(request),
                new ServletServerHttpResponse(response), null, attributes));
        assertEquals(13L, attributes.get(WsHandshakeInterceptor.USER_ID));
    }
}
