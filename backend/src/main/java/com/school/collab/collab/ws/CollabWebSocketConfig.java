package com.school.collab.collab.ws;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Bean;
import org.springframework.web.socket.server.standard.ServletServerContainerFactoryBean;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;
import org.springframework.web.socket.server.support.DefaultHandshakeHandler;

@Configuration
@EnableWebSocket
public class CollabWebSocketConfig implements WebSocketConfigurer {

    private final CollabWebSocketHandler handler;
    private final WsHandshakeInterceptor handshakeInterceptor;
    private final String frontendOrigin;

    public CollabWebSocketConfig(CollabWebSocketHandler handler,
                                 WsHandshakeInterceptor handshakeInterceptor,
                                 @Value("${collab.frontend-origin}") String frontendOrigin) {
        this.handler = handler;
        this.handshakeInterceptor = handshakeInterceptor;
        this.frontendOrigin = frontendOrigin;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        var handshake = new DefaultHandshakeHandler();
        handshake.setSupportedProtocols(WsHandshakeInterceptor.PROTOCOL);
        registry.addHandler(handler, "/ws/collab")
                .setHandshakeHandler(handshake)
                .addInterceptors(handshakeInterceptor)
                .setAllowedOrigins(frontendOrigin);
    }

    @Bean
    public ServletServerContainerFactoryBean webSocketContainer() {
        var container = new ServletServerContainerFactoryBean();
        container.setMaxTextMessageBufferSize(8 * 1024 * 1024);
        return container;
    }
}
