package com.school.collab.collab.persist;

import com.school.collab.config.RabbitMqConfig;
import org.junit.jupiter.api.Test;
import org.springframework.amqp.core.Message;
import org.springframework.amqp.core.ReturnedMessage;
import org.springframework.amqp.rabbit.connection.CorrelationData;
import org.springframework.amqp.rabbit.core.RabbitTemplate;

import java.util.ArrayDeque;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class ConfirmedDocPublisherTest {
    private final RabbitTemplate rabbit = mock(RabbitTemplate.class);
    private final LinkedBlockingQueue<CorrelationData> sends = new LinkedBlockingQueue<>();

    @Test
    void snapshotSucceedsOnlyAfterBrokerAck() throws Exception {
        captureSnapshotSends();
        var publisher = new ConfirmedDocPublisher(rabbit, Runnable::run, 5000);
        var result = CompletableFuture.supplyAsync(() -> publisher.publishSnapshot(9, 20));
        var correlation = sends.poll(3, TimeUnit.SECONDS);
        assertNotNull(correlation);
        assertFalse(result.isDone());
        correlation.getFuture().complete(new CorrelationData.Confirm(true, null));
        assertTrue(result.get(3, TimeUnit.SECONDS));
    }

    @Test
    void mandatoryReturnIsFailureEvenWhenBrokerAcksAndRetriesAreBounded() {
        doAnswer(call -> {
            CorrelationData correlation = call.getArgument(3);
            sends.add(correlation);
            correlation.setReturned(new ReturnedMessage(new Message(new byte[0]), 312, "NO_ROUTE",
                    RabbitMqConfig.DOC_EXCHANGE, RabbitMqConfig.SNAPSHOT_ROUTING_KEY));
            correlation.getFuture().complete(new CorrelationData.Confirm(true, null));
            return null;
        }).when(rabbit).convertAndSend(eq(RabbitMqConfig.DOC_EXCHANGE), eq(RabbitMqConfig.SNAPSHOT_ROUTING_KEY),
                eq(new DocPersistenceQueue.SnapshotRequested(9)), any(CorrelationData.class));

        assertFalse(new ConfirmedDocPublisher(rabbit, Runnable::run, 100).publishSnapshot(9, 20));
        assertEquals(3, sends.size());
        assertEquals(3, sends.stream().map(CorrelationData::getId).distinct().count());
    }

    @Test
    void nackAndTimeoutRetryWithNewCorrelationAndCanRecover() {
        doAnswer(call -> {
            CorrelationData correlation = call.getArgument(3);
            sends.add(correlation);
            if (sends.size() == 1) correlation.getFuture().complete(new CorrelationData.Confirm(false, "nack"));
            if (sends.size() == 3) correlation.getFuture().complete(new CorrelationData.Confirm(true, null));
            return null;
        }).when(rabbit).convertAndSend(eq(RabbitMqConfig.DOC_EXCHANGE), eq(RabbitMqConfig.SNAPSHOT_ROUTING_KEY),
                eq(new DocPersistenceQueue.SnapshotRequested(9)), any(CorrelationData.class));

        assertTrue(new ConfirmedDocPublisher(rabbit, Runnable::run, 10).publishSnapshot(9, 20));
        assertEquals(3, sends.stream().map(CorrelationData::getId).distinct().count());
    }

    @Test
    void operationIsDeferredAndAPublisherBacklogNeverRunsOnTheCommitThread() {
        var work = new ArrayDeque<Runnable>();
        var event = new DocPersistenceQueue.OperationCommitted(9, 1);
        var publisher = new ConfirmedDocPublisher(rabbit, work::add, 100);
        doAnswer(call -> {
            call.<CorrelationData>getArgument(3).getFuture().complete(new CorrelationData.Confirm(true, null));
            return null;
        }).when(rabbit).convertAndSend(eq(RabbitMqConfig.DOC_EXCHANGE), eq(RabbitMqConfig.OP_ROUTING_KEY),
                eq(event), any(CorrelationData.class));
        publisher.submitOperation(event);
        verifyNoInteractions(rabbit);
        work.remove().run();
        verify(rabbit).convertAndSend(eq(RabbitMqConfig.DOC_EXCHANGE), eq(RabbitMqConfig.OP_ROUTING_KEY),
                eq(event), any(CorrelationData.class));
        var saturated = new ConfirmedDocPublisher(rabbit, task -> { throw new RejectedExecutionException(); }, 100);
        assertDoesNotThrow(() -> saturated.submitOperation(event));
        verifyNoMoreInteractions(rabbit);
    }

    private void captureSnapshotSends() {
        doAnswer(call -> {
            sends.add(call.<CorrelationData>getArgument(3));
            return null;
        }).when(rabbit).convertAndSend(eq(RabbitMqConfig.DOC_EXCHANGE), eq(RabbitMqConfig.SNAPSHOT_ROUTING_KEY),
                eq(new DocPersistenceQueue.SnapshotRequested(9)), any(CorrelationData.class));
    }
}
