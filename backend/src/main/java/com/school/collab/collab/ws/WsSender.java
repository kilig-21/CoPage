package com.school.collab.collab.ws;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import java.io.IOException;

/** 同一底层连接的所有输出共用唯一装饰器，保留其并发队列、限额和异常语义。 */
@Component
public class WsSender {

    private final ObjectMapper objectMapper;

    public WsSender(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    public void send(WebSocketSession session, JsonNode payload) throws IOException {
        var safe = WsSessionRegistry.sendSessionFor(session);
        // 锁外入队：慢发送期间其它线程仍能计入缓冲量并触发装饰器的限额检查。
        if (safe.isOpen()) {
            safe.sendMessage(new TextMessage(objectMapper.writeValueAsString(payload)));
        }
    }
}
