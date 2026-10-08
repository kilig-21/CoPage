package com.school.collab.config.interceptor;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.auth.AccountSessions;
import com.school.collab.common.BizException;
import com.school.collab.common.ErrorCode;
import com.school.collab.common.Result;
import com.school.collab.common.UserContext;
import io.jsonwebtoken.JwtException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

@Component
public class JwtInterceptor implements HandlerInterceptor {
    private final AccountSessions sessions;
    private final ObjectMapper objectMapper;
    public JwtInterceptor(AccountSessions sessions, ObjectMapper objectMapper) {
        this.sessions=sessions; this.objectMapper=objectMapper;
    }
    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) throws Exception {
        UserContext.clear();
        if ("OPTIONS".equalsIgnoreCase(request.getMethod())) return true;
        String header=request.getHeader("Authorization");
        if(header==null || !header.startsWith("Bearer ")) return reject(response);
        try {
            var profile=sessions.authenticate(header.substring(7));
            UserContext.set(profile.id(),profile.username(),profile.credentialVersion());
            return true;
        } catch (BizException exception) {
            if(exception.getErrorCode()!=ErrorCode.UNAUTHORIZED) throw exception;
            return reject(response);
        } catch (JwtException | IllegalArgumentException exception) { return reject(response); }
        // 数据库等临时故障由全局处理器返回5xx，不能误判成登录失效。
    }
    @Override
    public void afterCompletion(HttpServletRequest request,HttpServletResponse response,Object handler,Exception exception) {
        UserContext.clear();
    }
    private boolean reject(HttpServletResponse response) throws Exception {
        response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
        response.setContentType("application/json;charset=UTF-8");
        response.getWriter().write(objectMapper.writeValueAsString(Result.fail(ErrorCode.UNAUTHORIZED)));
        return false;
    }
}
