package com.school.collab.collab.ws;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;
import org.springframework.web.socket.handler.WebSocketSessionDecorator;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class WsSessionRegistryTest {
    private WebSocketSession session(String id, Map<String, Object> attributes) {
        WebSocketSession raw = mock(WebSocketSession.class);
        when(raw.getId()).thenReturn(id);
        when(raw.getAttributes()).thenReturn(attributes);
        return raw;
    }

    @Test
    void 未加入时建立的默认发送队列在加入与换文档重加入后仍是同一个() {
        var raw = session("connection", new ConcurrentHashMap<>());
        var initial = WsSessionRegistry.sendSessionFor(raw);
        assertEquals(10000, initial.getSendTimeLimit());
        assertEquals(512 * 1024, initial.getBufferSizeLimit());
        var registry = new WsSessionRegistry();
        var first = registry.register(raw, 7, "first-client", 2, "昵称");
        var again = registry.register(raw, 8, "next-client", 2, "昵称");
        assertSame(initial, first.session());
        assertSame(initial, again.session());
        assertSame(again, registry.require(raw));
        assertTrue(registry.sessionsOf(7).isEmpty());
        assertEquals(1, registry.sessionsOf(8).size());
        registry.unregister(raw);
        assertTrue(registry.sessionsOf(8).isEmpty());
        assertSame(initial, WsSessionRegistry.sendSessionFor(raw), "同一连接解除文档注册不能重建另一把发送锁");
    }

    @Test
    void 首次显式装饰器保留限额且后续任意包装不能替换canonical() {
        var raw = session("connection", new ConcurrentHashMap<>());
        var explicit = new ConcurrentWebSocketSessionDecorator(raw, 20, 32);
        assertSame(explicit, WsSessionRegistry.sendSessionFor(explicit));
        assertSame(explicit, WsSessionRegistry.sendSessionFor(new WebSocketSessionDecorator(raw)));
        var registry = new WsSessionRegistry();
        assertSame(explicit, registry.register(raw, 7, "client", 2, "昵称").session());
        var later = new ConcurrentWebSocketSessionDecorator(raw, 10000, 1024 * 1024);
        assertSame(explicit, WsSessionRegistry.sendSessionFor(later));
        assertEquals(20, explicit.getSendTimeLimit());
        assertEquals(32, explicit.getBufferSizeLimit());
    }

    @Test
    void 同时初始化也只建立一个canonical且不同底层连接不共享缓存() throws Exception {
        var raw = session("same-id", new ConcurrentHashMap<>());
        var start = new CountDownLatch(1);
        try (var workers = Executors.newFixedThreadPool(2)) {
            var first = workers.submit(() -> { assertTrue(start.await(2, TimeUnit.SECONDS)); return WsSessionRegistry.sendSessionFor(raw); });
            var second = workers.submit(() -> { assertTrue(start.await(2, TimeUnit.SECONDS)); return WsSessionRegistry.sendSessionFor(raw); });
            start.countDown();
            assertSame(first.get(2, TimeUnit.SECONDS), second.get(2, TimeUnit.SECONDS));
        }
        var anotherRaw = session("same-id", new ConcurrentHashMap<>());
        assertNotSame(WsSessionRegistry.sendSessionFor(raw), WsSessionRegistry.sendSessionFor(anotherRaw));
    }

    @Test
    void 首次注册与raw发送并发时仍共享同一个canonical() throws Exception {
        var raw = session("connection", new ConcurrentHashMap<>());
        when(raw.isOpen()).thenReturn(true);
        var registry = new WsSessionRegistry();
        var sender = new WsSender(new ObjectMapper());
        var start = new CountDownLatch(1);
        try (var workers = Executors.newFixedThreadPool(2)) {
            var registration = workers.submit(() -> {
                assertTrue(start.await(2, TimeUnit.SECONDS));
                return registry.register(raw, 7, "client", 2, "昵称");
            });
            var sending = workers.submit(() -> {
                assertTrue(start.await(2, TimeUnit.SECONDS));
                sender.send(raw, new ObjectMapper().createObjectNode().put("type", "pong"));
                return WsSessionRegistry.sendSessionFor(raw);
            });
            start.countDown();
            assertSame(registration.get(2, TimeUnit.SECONDS).session(), sending.get(2, TimeUnit.SECONDS));
        }
        verify(raw).sendMessage(any(TextMessage.class));
    }

    @Test
    void 缓存中的装饰器若属于另一底层连接则拒绝而非错发或覆盖() {
        Map<String, Object> shared = new ConcurrentHashMap<>();
        var firstRaw = session("first", shared);
        var anotherRaw = session("second", shared);
        var canonical = WsSessionRegistry.sendSessionFor(firstRaw);
        assertThrows(IllegalStateException.class, () -> WsSessionRegistry.sendSessionFor(anotherRaw));
        assertSame(canonical, WsSessionRegistry.sendSessionFor(firstRaw));
    }
}
