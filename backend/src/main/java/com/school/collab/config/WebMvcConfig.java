package com.school.collab.config;

import com.school.collab.config.interceptor.JwtInterceptor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
public class WebMvcConfig implements WebMvcConfigurer {

    private final JwtInterceptor jwtInterceptor;
    private final String frontendOrigin;

    public WebMvcConfig(JwtInterceptor jwtInterceptor,
                        @Value("${collab.frontend-origin}") String frontendOrigin) {
        this.jwtInterceptor = jwtInterceptor;
        this.frontendOrigin = frontendOrigin;
    }

    @Override
    public void addCorsMappings(CorsRegistry registry) {
        registry.addMapping("/api/**")
                .allowedOrigins(frontendOrigin)
                .allowedMethods("GET", "POST", "PUT", "DELETE", "OPTIONS")
                .allowedHeaders("Authorization", "Content-Type")
                .allowCredentials(true);
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        // 除注册、登录外，所有 /api/** 都必须带 token（见 docs/接口约定.md）。
        // /ws/** 不走 MVC 拦截器，WebSocket 的鉴权在握手阶段用 ?token= 完成。
        registry.addInterceptor(jwtInterceptor)
                .addPathPatterns("/api/**")
                .excludePathPatterns("/api/auth/**", "/ws/**");
    }
}
