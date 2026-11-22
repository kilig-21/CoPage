package com.school.collab.collab.persist;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.ObjectReader;
import com.rabbitmq.client.Channel;
import com.school.collab.config.RabbitMqConfig;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.amqp.core.Message;
import org.springframework.amqp.rabbit.annotation.RabbitListener;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.dao.DataAccessException;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.TransactionException;

import java.io.IOException;
import java.util.function.BooleanSupplier;

/** 已持久化操作经 MQ 触发异步快照；定时巡检弥补提交后漏发的通知。 */
@Component
public class DocPersistenceQueue {
    private static final Logger log = LoggerFactory.getLogger(DocPersistenceQueue.class);
    private static final int MAX_NOTICE_BYTES = 1024;
    private static final int CONSUMPTION_ATTEMPTS = 3;
    private static final int REPAIR_BATCH = 100;

    private final ConfirmedDocPublisher publisher;
    private final DocumentPersistence persistence;
    private final ObjectReader operationReader;
    private final ObjectReader snapshotReader;
    private final int interval;
    private long repairAfter;

    public DocPersistenceQueue(ConfirmedDocPublisher publisher, DocumentPersistence persistence, ObjectMapper mapper,
                               @Value("${collab.snapshot.interval:20}") int interval) {
        if (interval < 1) throw new IllegalArgumentException("快照间隔必须大于 0");
        this.publisher = publisher;
        this.persistence = persistence;
        this.operationReader = noticeReader(mapper, OperationCommitted.class);
        this.snapshotReader = noticeReader(mapper, SnapshotRequested.class);
        this.interval = interval;
    }

    public void publishCommitted(long docId, long revision) {
        publisher.submitOperation(new OperationCommitted(docId, revision));
    }

    private static ObjectReader noticeReader(ObjectMapper mapper, Class<?> event) {
        return mapper.readerFor(event).with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS,
                DeserializationFeature.FAIL_ON_NULL_FOR_PRIMITIVES)
                .without(DeserializationFeature.ACCEPT_FLOAT_AS_INT);
    }

    private static <T> T parse(Message message, ObjectReader reader) {
        if (message.getBody().length > MAX_NOTICE_BYTES) return null;
        try {
            return reader.readValue(message.getBody());
        } catch (IOException invalidJson) {
            return null;
        }
    }

    @RabbitListener(queues = RabbitMqConfig.OP_QUEUE, concurrency = "${collab.mq.operation-consumers:2}")
    public void onOperation(Message message, Channel channel) throws IOException {
        long tag = message.getMessageProperties().getDeliveryTag();
        OperationCommitted event = parse(message, operationReader);
        if (event == null || event.docId() <= 0 || event.revision() <= 0) {
            log.warn("RabbitMQ 拒绝无效操作通知，转入死信队列");
            channel.basicNack(tag, false, false);
            return;
        }
        handle(channel, tag, RabbitMqConfig.OP_ROUTING_KEY, event.docId(), event.revision(), () -> {
            if (!persistence.operationExists(event.docId(), event.revision())) {
                return event.revision() <= persistence.minimumRevision(event.docId());
            }
            // 待索引标记与操作在同一事务提交，由搜索巡检合并处理。
            if (event.revision() % interval == 0 && !publisher.publishSnapshot(event.docId(), event.revision())) {
                persistence.saveSnapshotIfNeeded(event.docId(), interval);
            }
            return true;
        });
    }

    @RabbitListener(queues = RabbitMqConfig.SNAPSHOT_QUEUE, concurrency = "${collab.mq.snapshot-consumers:2}")
    public void onSnapshot(Message message, Channel channel) throws IOException {
        long tag = message.getMessageProperties().getDeliveryTag();
        SnapshotRequested event = parse(message, snapshotReader);
        if (event == null || event.docId() <= 0) {
            log.warn("RabbitMQ 拒绝无效快照请求，转入死信队列");
            channel.basicNack(tag, false, false);
            return;
        }
        handle(channel, tag, RabbitMqConfig.SNAPSHOT_ROUTING_KEY, event.docId(), 0, () -> {
            persistence.saveSnapshotIfNeeded(event.docId(), interval);
            return true;
        });
    }

    private void handle(Channel channel, long tag, String route, long docId, long revision,
                        BooleanSupplier process) throws IOException {
        boolean handled = false;
        String failureReason = "MISSING_OPERATION";
        for (int attempt = 1; attempt <= CONSUMPTION_ATTEMPTS; attempt++) {
            try {
                handled = process.getAsBoolean();
                if (!handled) failureReason = "MISSING_OPERATION";
                break;
            } catch (DataAccessException | TransactionException failure) {
                failureReason = failure.getClass().getSimpleName();
                if (attempt < CONSUMPTION_ATTEMPTS) {
                    try {
                        Thread.sleep(100L * attempt);
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        throw new IOException("RabbitMQ 消费重试被中断", interrupted);
                    }
                }
            } catch (RuntimeException failure) {
                failureReason = failure.getClass().getSimpleName();
                break;
            }
        }
        // 如果 ack 本身失败，由 broker 决定是否重投，不在相同 delivery tag 上再发 nack。
        if (handled) {
            channel.basicAck(tag, false);
        } else {
            log.warn("RabbitMQ 消费失败，转入死信队列, route={}, docId={}, revision={}, reason={}",
                    route, docId, revision, failureReason);
            channel.basicNack(tag, false, false);
        }
    }

    @Scheduled(initialDelayString = "${collab.snapshot.repair-initial-delay-ms:30000}",
            fixedDelayString = "${collab.snapshot.repair-interval-ms:60000}")
    public void repairMissedSnapshots() {
        try {
            var candidates = persistence.snapshotCandidates(interval, repairAfter, REPAIR_BATCH);
            for (long docId : candidates) {
                repairAfter = docId;
                try {
                    persistence.saveSnapshotIfNeeded(docId, interval);
                } catch (RuntimeException failure) {
                    log.warn("巡检暂未补建快照, docId={}, reason={}", docId, failure.getClass().getSimpleName());
                }
            }
            if (candidates.size() < REPAIR_BATCH) repairAfter = 0;
        } catch (RuntimeException failure) {
            log.warn("快照巡检暂时失败，下轮重试, reason={}", failure.getClass().getSimpleName());
        }
    }

    public record OperationCommitted(long docId, long revision) {
    }

    public record SnapshotRequested(long docId) {
    }
}
