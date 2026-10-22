package com.school.collab.collab.ws;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;
import org.springframework.web.socket.handler.SessionLimitExceededException;
import org.springframework.web.socket.handler.WebSocketSessionDecorator;

import java.io.IOException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.ConcurrentHashMap;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

class WsSenderTest {
    private final ObjectMapper mapper = new ObjectMapper();
    private final WsSender sender = new WsSender(mapper);

    private WebSocketSession openSession() {
        WebSocketSession raw = mock(WebSocketSession.class);
        when(raw.isOpen()).thenReturn(true);
        when(raw.getAttributes()).thenReturn(new ConcurrentHashMap<>());
        return raw;
    }

    @Test
    void 首个发送阻塞时原始会话仍能触发共享缓冲上限() throws Exception {
        assertSlowLimit(false, false);
    }

    @Test
    void 首个发送阻塞时旧包装仍使用首个包装的缓冲上限() throws Exception {
        assertSlowLimit(true, false);
    }

    @Test
    void 首个发送超时时后续发送仍能触发时间上限() throws Exception {
        assertSlowLimit(false, true);
    }

    private void assertSlowLimit(boolean oldWrapper, boolean timeLimit) throws Exception {
        WebSocketSession raw = openSession();
        var canonical = new ConcurrentWebSocketSessionDecorator(raw, timeLimit ? 20 : 10000, timeLimit ? 1024 : 32);
        var entered = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        var finished = new CountDownLatch(1);
        var error = new AtomicReference<Throwable>();
        doAnswer(invocation -> { entered.countDown(); assertTrue(release.await(5, TimeUnit.SECONDS)); return null; })
                .when(raw).sendMessage(any());
        WebSocketSession next = oldWrapper ? new ConcurrentWebSocketSessionDecorator(raw, 10000, 1024 * 1024) : raw;
        try (var workers = Executors.newFixedThreadPool(2)) {
            var first = workers.submit(() -> { sender.send(canonical, mapper.createObjectNode().put("a", "first")); return null; });
            try {
                assertTrue(entered.await(2, TimeUnit.SECONDS));
                if (timeLimit) {
                    Thread.sleep(40);
                    assertTrue(canonical.getTimeSinceSendStarted() > canonical.getSendTimeLimit());
                }
                var second = workers.submit(() -> {
                    try { sender.send(next, mapper.createObjectNode().put("value", timeLimit ? "next" : "x".repeat(40))); }
                    catch (Throwable failure) { error.set(failure); }
                    finally { finished.countDown(); }
                });
                assertTrue(finished.await(1, TimeUnit.SECONDS), "后续发送应进入装饰器检查限额，不能在外层锁等待首个发送");
                var limit = assertInstanceOf(SessionLimitExceededException.class, error.get());
                assertTrue(limit.getMessage().contains(timeLimit ? "Send time" : "Buffer size"));
                second.get(2, TimeUnit.SECONDS);
            } finally {
                release.countDown();
            }
            first.get(2, TimeUnit.SECONDS);
        }
    }

    @Test
    void 阻塞期间raw与旧包装的小消息进入同一队列且调用及时返回() throws Exception {
        WebSocketSession raw = openSession();
        var canonical = new ConcurrentWebSocketSessionDecorator(raw, 10000, 1024);
        var oldWrapper = new ConcurrentWebSocketSessionDecorator(raw, 10000, 1024);
        var entered = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        var completed = new CountDownLatch(2);
        var calls = new AtomicInteger();
        doAnswer(invocation -> {
            if (calls.incrementAndGet() == 1) { entered.countDown(); assertTrue(release.await(5, TimeUnit.SECONDS)); }
            return null;
        }).when(raw).sendMessage(any());
        var queued = mapper.createObjectNode().put("type", "pong");
        int size = new TextMessage(mapper.writeValueAsString(queued)).getPayloadLength();
        try (var workers = Executors.newFixedThreadPool(3)) {
            var first = workers.submit(() -> { sender.send(canonical, mapper.createObjectNode()); return null; });
            try {
                assertTrue(entered.await(2, TimeUnit.SECONDS));
                var second = workers.submit(() -> { sender.send(raw, queued); completed.countDown(); return null; });
                var third = workers.submit(() -> { sender.send(oldWrapper, queued); completed.countDown(); return null; });
                assertTrue(completed.await(1, TimeUnit.SECONDS), "两条小消息应已入队而非阻塞调用线程");
                assertEquals(size * 2, canonical.getBufferSize());
                assertEquals(1, calls.get(), "首个发送未结束前不能写入第二帧");
                second.get(2, TimeUnit.SECONDS); third.get(2, TimeUnit.SECONDS);
            } finally {
                release.countDown();
            }
            first.get(2, TimeUnit.SECONDS);
        }
        assertEquals(3, calls.get());
        assertEquals(0, canonical.getBufferSize());
    }

    @Test
    void 原始错误回复与已注册包装会话广播不能重叠发送() throws Exception {
        assertSerialized(false);
    }

    @Test
    void 重复加入前后两个包装会话仍按同一底层连接串行发送() throws Exception {
        assertSerialized(true);
    }

    private void assertSerialized(boolean secondDecorator) throws Exception {
        WebSocketSession raw = openSession();
        var firstEntered = new CountDownLatch(1);
        var releaseFirst = new CountDownLatch(1);
        var secondAttempted = new CountDownLatch(1);
        var secondEntered = new CountDownLatch(1);
        var calls = new AtomicInteger();
        var active = new AtomicInteger();
        var maximum = new AtomicInteger();
        doAnswer(invocation -> {
            maximum.accumulateAndGet(active.incrementAndGet(), Math::max);
            try {
                if (calls.incrementAndGet() == 1) {
                    firstEntered.countDown();
                    assertTrue(releaseFirst.await(5, TimeUnit.SECONDS), "首个真实发送未释放");
                } else secondEntered.countDown();
                return null;
            } finally {
                active.decrementAndGet();
            }
        }).when(raw).sendMessage(any());
        WebSocketSession first = new ConcurrentWebSocketSessionDecorator(raw, 10000, 512 * 1024);
        WebSocketSession second = secondDecorator
                ? new ConcurrentWebSocketSessionDecorator(raw, 10000, 512 * 1024) : raw;
        try (var workers = Executors.newFixedThreadPool(2)) {
            var firstResult = workers.submit(() -> {
                sender.send(first, mapper.createObjectNode().put("type", "op"));
                return null;
            });
            try {
                assertTrue(firstEntered.await(2, TimeUnit.SECONDS));
                var secondResult = workers.submit(() -> {
                    secondAttempted.countDown();
                    sender.send(second, mapper.createObjectNode().put("type", "error"));
                    return null;
                });
                try {
                    assertTrue(secondAttempted.await(2, TimeUnit.SECONDS));
                    assertFalse(secondEntered.await(250, TimeUnit.MILLISECONDS), "同一连接的第二个发送越过了首个发送");
                } finally {
                    releaseFirst.countDown();
                }
                firstResult.get(2, TimeUnit.SECONDS);
                secondResult.get(2, TimeUnit.SECONDS);
            } finally {
                releaseFirst.countDown();
            }
        }
        assertEquals(2, calls.get());
        assertEquals(1, maximum.get(), "底层连接不能出现并发发送");
    }

    @Test
    void 一条连接正在发送时不阻塞独立连接() throws Exception {
        WebSocketSession first = openSession(), second = openSession();
        var firstEntered = new CountDownLatch(1);
        var releaseFirst = new CountDownLatch(1);
        var secondSent = new CountDownLatch(1);
        doAnswer(invocation -> {
            firstEntered.countDown();
            assertTrue(releaseFirst.await(5, TimeUnit.SECONDS));
            return null;
        }).when(first).sendMessage(any());
        doAnswer(invocation -> { secondSent.countDown(); return null; }).when(second).sendMessage(any());
        try (var workers = Executors.newFixedThreadPool(2)) {
            var firstResult = workers.submit(() -> { sender.send(first, mapper.createObjectNode()); return null; });
            try {
                assertTrue(firstEntered.await(2, TimeUnit.SECONDS));
                var secondResult = workers.submit(() -> { sender.send(second, mapper.createObjectNode()); return null; });
                assertTrue(secondSent.await(2, TimeUnit.SECONDS), "独立连接不能被全局发送锁阻塞");
                secondResult.get(2, TimeUnit.SECONDS);
            } finally {
                releaseFirst.countDown();
            }
            firstResult.get(2, TimeUnit.SECONDS);
        }
    }

    @Test
    void 原始会话与任意旧包装都进入首个canonical而不是各自的发送队列() throws Exception {
        WebSocketSession raw = openSession();
        var canonical = spy(new ConcurrentWebSocketSessionDecorator(raw, 10000, 512 * 1024));
        var oldWrapper = spy(new WebSocketSessionDecorator(new ConcurrentWebSocketSessionDecorator(raw, 10000, 1024)));
        sender.send(canonical, mapper.createObjectNode().put("type", "ack"));
        sender.send(oldWrapper, mapper.createObjectNode().put("type", "pong"));
        sender.send(raw, mapper.createObjectNode().put("type", "error"));
        assertSame(canonical, WsSessionRegistry.sendSessionFor(raw));
        verify(canonical, times(3)).sendMessage(any(TextMessage.class));
        verify(oldWrapper, never()).sendMessage(any());
        verify(raw, times(3)).sendMessage(any(TextMessage.class));
    }

    @Test
    void 已关闭连接不序列化也不发送() throws Exception {
        WebSocketSession raw = mock(WebSocketSession.class);
        when(raw.getAttributes()).thenReturn(new ConcurrentHashMap<>());
        ObjectMapper unused = mock(ObjectMapper.class);
        new WsSender(unused).send(new ConcurrentWebSocketSessionDecorator(raw, 10000, 512 * 1024), mapper.createObjectNode());
        verify(raw, never()).sendMessage(any());
        verifyNoInteractions(unused);
    }

    @Test
    void 原始发送IOException和运行时错误继续透出() throws Exception {
        WebSocketSession raw = openSession();
        var io = new IOException("write failed");
        doThrow(io).when(raw).sendMessage(any());
        assertSame(io, assertThrows(IOException.class, () -> sender.send(raw, mapper.createObjectNode())));
        var state = new IllegalStateException("session closed during send");
        doThrow(state).when(raw).sendMessage(any());
        assertSame(state, assertThrows(IllegalStateException.class, () -> sender.send(raw, mapper.createObjectNode())));
    }
}
