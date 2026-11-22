package com.school.collab.collab.persist;

import com.school.collab.config.RabbitMqConfig;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.amqp.rabbit.connection.CorrelationData;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executor;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

@Component
class ConfirmedDocPublisher {
    private static final Logger log = LoggerFactory.getLogger(ConfirmedDocPublisher.class);
    private static final int ATTEMPTS = 3;

    private final RabbitTemplate rabbit;
    private final Executor executor;
    private final long timeoutMillis;

    ConfirmedDocPublisher(RabbitTemplate rabbit, @Qualifier("docPublishExecutor") Executor executor,
                          @Value("${collab.mq.confirm-timeout-ms:1500}") long timeoutMillis) {
        if (timeoutMillis < 1) throw new IllegalArgumentException("MQ 确认超时必须大于 0");
        this.rabbit = rabbit;
        this.executor = executor;
        this.timeoutMillis = timeoutMillis;
    }

    void submitOperation(DocPersistenceQueue.OperationCommitted event) {
        // 协同提交路径持有文档锁，不能在调用线程等待 broker 或触发 caller-runs。
        try {
            executor.execute(() -> publish(RabbitMqConfig.OP_ROUTING_KEY, event, event.docId(), event.revision()));
        } catch (RejectedExecutionException failure) {
            log.warn("RabbitMQ 通知未提交到发布线程，交由巡检补偿, route={}, docId={}, revision={}",
                    RabbitMqConfig.OP_ROUTING_KEY, event.docId(), event.revision());
        }
    }

    boolean publishSnapshot(long docId, long revision) {
        return publish(RabbitMqConfig.SNAPSHOT_ROUTING_KEY, new DocPersistenceQueue.SnapshotRequested(docId), docId, revision);
    }

    private boolean publish(String route, Object event, long docId, long revision) {
        String result = "UNCONFIRMED";
        for (int attempt = 1; attempt <= ATTEMPTS; attempt++) {
            var correlation = new CorrelationData();
            try {
                if (attempt > 1) Thread.sleep(100L * (attempt - 1));
                rabbit.convertAndSend(RabbitMqConfig.DOC_EXCHANGE, route, event, correlation);
                var confirm = correlation.getFuture().get(timeoutMillis, TimeUnit.MILLISECONDS);
                // Mandatory returns are recorded before the confirm future completes.
                if (confirm.isAck() && correlation.getReturned() == null) return true;
                result = correlation.getReturned() == null ? "NACK" : "RETURNED";
            } catch (InterruptedException failure) {
                Thread.currentThread().interrupt();
                log.warn("RabbitMQ 通知确认中断，交由巡检补偿, route={}, docId={}, revision={}", route, docId, revision);
                return false;
            } catch (TimeoutException failure) {
                result = "TIMEOUT";
            } catch (ExecutionException | RuntimeException failure) {
                result = failure.getClass().getSimpleName();
            }
        }
        log.warn("RabbitMQ 通知确认失败，交由巡检补偿, route={}, docId={}, revision={}, attempts={}, result={}",
                route, docId, revision, ATTEMPTS, result);
        return false;
    }
}
