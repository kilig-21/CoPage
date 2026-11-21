package com.school.collab.auth;

import com.school.collab.common.BizException;
import com.school.collab.common.ErrorCode;
import com.school.collab.common.GlobalExceptionHandler;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

class AuthControllerRateTest {
    private final AuthService accounts = mock(AuthService.class);
    private final AuthRateLimiter limiter = mock(AuthRateLimiter.class);
    private final MockMvc mvc = MockMvcBuilders.standaloneSetup(new AuthController(accounts, limiter, mock(AccountSessions.class)))
            .setControllerAdvice(new GlobalExceptionHandler()).build();

    @Test
    void rejectedRegistrationReturnsChinese429WithRetryAfterAndNeverWritesAccount() throws Exception {
        doThrow(new AuthRateLimiter.Limited(7, "注册请求过于频繁，请在 7 秒后重试"))
                .when(limiter).allowRegistration(any(), eq("synthetic"));
        mvc.perform(post("/api/auth/register").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"synthetic\",\"password\":\"fixture-password\"}"))
                .andExpect(status().isTooManyRequests()).andExpect(header().string("Retry-After", "7"))
                .andExpect(jsonPath("$.code").value(429))
                .andExpect(jsonPath("$.message").value("注册请求过于频繁，请在 7 秒后重试"));
        verifyNoInteractions(accounts);
    }

    @Test
    void credentialRejectionsAreRecordedButFailedDependenciesAreNot() throws Exception {
        when(limiter.allowLogin(any(), eq("synthetic"))).thenReturn("fixture-key");
        when(accounts.login(anyString(), anyString())).thenThrow(new BizException(ErrorCode.UNAUTHORIZED, "用户名或密码错误"))
                .thenThrow(new IllegalStateException("synthetic dependency failure"));
        var request = post("/api/auth/login").contentType(MediaType.APPLICATION_JSON)
                .content("{\"username\":\"synthetic\",\"password\":\"fixture-password\"}");
        mvc.perform(request).andExpect(status().isUnauthorized());
        mvc.perform(request).andExpect(status().isInternalServerError());
        verify(limiter).loginFailed("fixture-key");
        verify(limiter, never()).loginSucceeded(anyString());
    }
}
