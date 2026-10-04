package com.school.collab.config;

import com.school.collab.collab.persist.DocPersistenceQueue.OperationCommitted;
import com.school.collab.collab.persist.DocPersistenceQueue.SnapshotRequested;
import org.junit.jupiter.api.Test;
import org.springframework.amqp.core.Message;
import org.springframework.amqp.core.MessageProperties;
import org.springframework.amqp.support.converter.MessageConverter;

import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class RabbitMqConfigTest {
    private final MessageConverter converter = new RabbitMqConfig().jsonMessageConverter();

    @Test
    void 操作通知和快照请求应通过实际消息转换器往返且保留旧头格式() {
        for (Object event : new Object[]{new OperationCommitted(9, 20), new SnapshotRequested(9)}) {
            Message message = converter.toMessage(event, new MessageProperties());
            assertEquals(event.getClass().getName(), message.getMessageProperties().getHeader("__TypeId__"));
            assertEquals(event, converter.fromMessage(message));
        }
    }

    @Test
    void 已在队列中的完整类名消息应可读取() {
        assertEquals(new OperationCommitted(9, 20), converter.fromMessage(
                message(OperationCommitted.class.getName(), "{\"docId\":9,\"revision\":20}")));
        assertEquals(new SnapshotRequested(9), converter.fromMessage(
                message(SnapshotRequested.class.getName(), "{\"docId\":9}")));
    }

    @Test
    void 未映射的应用类和第三方类型仍应被拒绝() {
        for (String type : new String[]{RabbitMqConfig.class.getName(), "java.io.File"}) {
            assertThrows(IllegalArgumentException.class, () -> converter.fromMessage(message(type, "{}")));
        }
    }

    private Message message(String type, String json) {
        var properties = new MessageProperties();
        properties.setContentType(MessageProperties.CONTENT_TYPE_JSON);
        properties.setHeader("__TypeId__", type);
        return new Message(json.getBytes(StandardCharsets.UTF_8), properties);
    }
}
