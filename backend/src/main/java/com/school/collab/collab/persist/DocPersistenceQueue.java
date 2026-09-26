package com.school.collab.collab.persist;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.rabbitmq.client.Channel;
import com.school.collab.config.RabbitMqConfig;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.amqp.core.Message;
import org.springframework.amqp.rabbit.annotation.RabbitListener;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.io.IOException;

/** 已持久化操作经 MQ 触发异步快照；定时巡检弥补数据库提交后、发消息前的崩溃窗口。 */
@Component
public class DocPersistenceQueue {
    private static final Logger log = LoggerFactory.getLogger(DocPersistenceQueue.class);

    private final RabbitTemplate rabbit;
    private final DocumentPersistence persistence;
    private final ObjectMapper mapper;
    private final int interval;

    public DocPersistenceQueue(RabbitTemplate rabbit, DocumentPersistence persistence,
                               ObjectMapper mapper,
                               @Value("${collab.snapshot.interval:20}") int interval) {
        this.rabbit = rabbit;
        this.persistence = persistence;
        this.mapper = mapper;
        this.interval = interval;
        if (interval < 1) {
            throw new IllegalArgumentException("快照间隔必须大于 0");
        }
    }

    public void publishCommitted(long docId, long revision) {
        rabbit.convertAndSend(RabbitMqConfig.DOC_EXCHANGE,
                RabbitMqConfig.OP_ROUTING_KEY, new OperationCommitted(docId, revision));
    }

    private void requestSnapshot(long docId) {
        rabbit.convertAndSend(RabbitMqConfig.DOC_EXCHANGE,
                RabbitMqConfig.SNAPSHOT_ROUTING_KEY, new SnapshotRequested(docId));
    }

    @RabbitListener(queues = RabbitMqConfig.OP_QUEUE)
    public void onOperation(Message message, Channel channel) throws IOException {
        long tag = message.getMessageProperties().getDeliveryTag();
        try {
            OperationCommitted event = mapper.readValue(message.getBody(), OperationCommitted.class);
            if (!persistence.operationExists(event.docId(), event.revision())) {
                throw new IllegalStateException("操作日志尚未落库: " + event);
            }
            if (event.revision() % interval == 0) {
                requestSnapshot(event.docId());
            }
            channel.basicAck(tag, false);
        } catch (Exception exception) {
            log.error("操作通知处理失败，已送死信队列", exception);
            channel.basicNack(tag, false, false);
        }
    }

    @RabbitListener(queues = RabbitMqConfig.SNAPSHOT_QUEUE)
    public void onSnapshot(Message message, Channel channel) throws IOException {
        long tag = message.getMessageProperties().getDeliveryTag();
        try {
            SnapshotRequested event = mapper.readValue(message.getBody(), SnapshotRequested.class);
            persistence.saveSnapshotIfNeeded(event.docId(), interval);
            channel.basicAck(tag, false);
        } catch (Exception exception) {
            log.error("快照任务处理失败，已送死信队列", exception);
            channel.basicNack(tag, false, false);
        }
    }

    @Scheduled(initialDelay = 30_000, fixedDelay = 60_000)
    public void repairMissedSnapshots() {
        try {
            for (Long docId : persistence.snapshotCandidates(interval)) {
                requestSnapshot(docId);
            }
        } catch (RuntimeException exception) {
            log.warn("快照巡检暂时失败，下轮重试", exception);
        }
    }

    public record OperationCommitted(long docId, long revision) {
    }

    public record SnapshotRequested(long docId) {
    }
}
