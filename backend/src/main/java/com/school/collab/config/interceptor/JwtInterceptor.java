package com.school.collab.config.interceptor;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.common.ErrorCode;
import com.school.collab.common.JwtUtil;
import com.school.collab.common.Result;
import com.school.collab.common.UserContext;
import io.jsonwebtoken.Claims;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

/**
 * 校验 {@code Authorization: Bearer <token>}，通过后把用户信息写入 {@link UserContext}。
 * 拦截路径与白名单在 {@link com.school.collab.config.WebMvcConfig} 中声明。
 */
@Component
public class JwtInterceptor implements HandlerInterceptor {

    private final String secret;
    private final ObjectMapper objectMapper;

    public JwtInterceptor(@Value("${collab.jwt.secret}") String secret, ObjectMapper objectMapper) {
        this.secret = secret;
        this.objectMapper = objectMapper;
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) throws Exception {
        // CORS 预检请求不带 Authorization，直接放行
        if ("OPTIONS".equalsIgnoreCase(request.getMethod())) {
            return true;
        }
        String header = request.getHeader("Authorization");
        if (header == null || !header.startsWith("Bearer ")) {
            return reject(response);
        }
        try {
            Claims claims = JwtUtil.parse(header.substring(7), secret);
            UserContext.set(Long.valueOf(claims.getSubject()), claims.get("username", String.class));
            return true;
        } catch (Exception exception) {
            // token 过期、签名不符、格式错误都走这里
            return reject(response);
        }
    }

    @Override
    public void afterCompletion(HttpServletRequest request, HttpServletResponse response, Object handler, Exception exception) {
        // ThreadLocal 必须清理，否则线程复用时会把上一个用户的身份泄露给下一个请求
        UserContext.clear();
    }

    /** 直接写 401 JSON 响应，不抛异常（抛异常会被全局处理器转成 500）。 */
    private boolean reject(HttpServletResponse response) throws Exception {
        response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
        response.setContentType("application/json;charset=UTF-8");
        response.getWriter().write(objectMapper.writeValueAsString(Result.fail(ErrorCode.UNAUTHORIZED)));
        return false;
    }
}
