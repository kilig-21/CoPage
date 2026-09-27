package com.school.collab.collab.persist;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.rabbitmq.client.Channel;
import com.school.collab.config.RabbitMqConfig;
import com.school.collab.search.SearchIndex;
import org.junit.jupiter.api.Test;
import org.springframework.amqp.core.Message;
import org.springframework.amqp.core.MessageProperties;
import org.springframework.amqp.rabbit.core.RabbitTemplate;

import java.util.List;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class DocPersistenceQueueTest {
    private final RabbitTemplate rabbit = mock(RabbitTemplate.class);
    private final DocumentPersistence persistence = mock(DocumentPersistence.class);
    private final ObjectMapper mapper = new ObjectMapper();
    private final SearchIndex searchIndex = mock(SearchIndex.class);
    private final DocPersistenceQueue queue = new DocPersistenceQueue(rabbit, persistence, mapper, searchIndex, 2);
    private final Channel channel = mock(Channel.class);

    @Test
    void 已持久化操作达到间隔时应请求快照并确认消息() throws Exception {
        when(persistence.operationExists(9, 2)).thenReturn(true);

        queue.onOperation(message(new DocPersistenceQueue.OperationCommitted(9, 2)), channel);

        verify(rabbit).convertAndSend(RabbitMqConfig.DOC_EXCHANGE,
                RabbitMqConfig.SNAPSHOT_ROUTING_KEY,
                new DocPersistenceQueue.SnapshotRequested(9));
        verify(channel).basicAck(17, false);
        verify(searchIndex).upsertEventually(9);
    }

    @Test
    void 快照请求可幂等处理且确认消息() throws Exception {
        queue.onSnapshot(message(new DocPersistenceQueue.SnapshotRequested(9)), channel);

        verify(persistence).saveSnapshotIfNeeded(9, 2);
        verify(channel).basicAck(17, false);
    }

    @Test
    void 巡检应补发漏掉的快照请求() {
        when(persistence.snapshotCandidates(2)).thenReturn(List.of(9L));

        queue.repairMissedSnapshots();

        verify(rabbit).convertAndSend(RabbitMqConfig.DOC_EXCHANGE,
                RabbitMqConfig.SNAPSHOT_ROUTING_KEY,
                new DocPersistenceQueue.SnapshotRequested(9));
    }

    private Message message(Object payload) throws Exception {
        MessageProperties properties = new MessageProperties();
        properties.setDeliveryTag(17);
        return new Message(mapper.writeValueAsBytes(payload), properties);
    }
}
