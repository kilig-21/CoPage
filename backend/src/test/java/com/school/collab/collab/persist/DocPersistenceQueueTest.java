package com.school.collab.collab.persist;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.rabbitmq.client.Channel;
import org.junit.jupiter.api.Test;
import org.springframework.amqp.core.Message;
import org.springframework.amqp.core.MessageProperties;
import org.springframework.dao.DataAccessResourceFailureException;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.stream.LongStream;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.*;

class DocPersistenceQueueTest {
    private final ConfirmedDocPublisher publisher = mock(ConfirmedDocPublisher.class);
    private final DocumentPersistence persistence = mock(DocumentPersistence.class);
    private final ObjectMapper mapper = new ObjectMapper();
    private final DocPersistenceQueue queue = new DocPersistenceQueue(publisher, persistence, mapper, 2);
    private final Channel channel = mock(Channel.class);

    @Test
    void persistedOperationAtSnapshotIntervalRequestsSnapshotAndAcks() throws Exception {
        when(persistence.operationExists(9, 2)).thenReturn(true);
        when(publisher.publishSnapshot(9, 2)).thenReturn(true);

        queue.onOperation(message(new DocPersistenceQueue.OperationCommitted(9, 2)), channel);

        verify(channel).basicAck(17, false);
        verify(publisher).publishSnapshot(9, 2);
        verify(persistence, never()).saveSnapshotIfNeeded(anyLong(), anyInt());
    }

    @Test
    void failedSnapshotPublishFallsBackToMysqlBeforeAck() throws Exception {
        when(persistence.operationExists(9, 2)).thenReturn(true);
        var order = inOrder(publisher, persistence, channel);

        queue.onOperation(message(new DocPersistenceQueue.OperationCommitted(9, 2)), channel);

        order.verify(publisher).publishSnapshot(9, 2);
        order.verify(persistence).saveSnapshotIfNeeded(9, 2);
        order.verify(channel).basicAck(17, false);
    }

    @Test
    void prunedRevisionAcksAtTheBoundaryWithoutRequestingSnapshot() throws Exception {
        when(persistence.minimumRevision(9)).thenReturn(2L);

        queue.onOperation(message(new DocPersistenceQueue.OperationCommitted(9, 2)), channel);

        verify(channel).basicAck(17, false);
        verify(channel, never()).basicNack(anyLong(), anyBoolean(), anyBoolean());
        verifyNoInteractions(publisher);
    }

    @Test
    void genuinelyMissingRevisionAboveBoundaryDeadLettersWithoutRetry() throws Exception {
        when(persistence.minimumRevision(9)).thenReturn(1L);

        queue.onOperation(message(new DocPersistenceQueue.OperationCommitted(9, 2)), channel);

        verify(persistence).operationExists(9, 2);
        verify(persistence).minimumRevision(9);
        verify(channel).basicNack(17, false, false);
        verify(channel, never()).basicAck(anyLong(), anyBoolean());
        verifyNoInteractions(publisher);
    }

    @Test
    void malformedNotificationsAreDeadLetteredBeforeDatabaseAccess() throws Exception {
        for (String body : List.of("invalid", "null", "{}", "{\"docId\":0,\"revision\":2}",
                "{\"docId\":9,\"revision\":0}", "{\"docId\":9,\"revision\":null}",
                "{\"docId\":9,\"revision\":2.1}", "{\"docId\":9,\"revision\":2} {}", " ".repeat(1025))) {
            queue.onOperation(message(body.getBytes(StandardCharsets.UTF_8)), channel);
        }

        verify(channel, times(9)).basicNack(17, false, false);
        verifyNoInteractions(publisher, persistence);
    }

    @Test
    void databaseFailureIsRetriedWithinTheSameDeliveryAndCanRecover() throws Exception {
        when(persistence.operationExists(9, 1))
                .thenThrow(new DataAccessResourceFailureException("transient"))
                .thenReturn(true);

        queue.onOperation(message(new DocPersistenceQueue.OperationCommitted(9, 1)), channel);

        verify(persistence, times(2)).operationExists(9, 1);
        verify(channel).basicAck(17, false);
        verifyNoInteractions(publisher);
    }

    @Test
    void snapshotRetriesAreBoundedAndRejectedWithoutRequeue() throws Exception {
        doThrow(new DataAccessResourceFailureException("transient")).when(persistence).saveSnapshotIfNeeded(9, 2);

        queue.onSnapshot(message(new DocPersistenceQueue.SnapshotRequested(9)), channel);

        verify(persistence, times(3)).saveSnapshotIfNeeded(9, 2);
        verify(channel).basicNack(17, false, false);
        verify(channel, never()).basicAck(anyLong(), anyBoolean());
    }

    @Test
    void ackIoFailureDoesNotSendASecondDispositionForTheSameDelivery() throws Exception {
        doThrow(new IOException("channel closed")).when(channel).basicAck(17, false);

        assertThrows(IOException.class, () -> queue.onSnapshot(message(new DocPersistenceQueue.SnapshotRequested(9)), channel));

        verify(persistence).saveSnapshotIfNeeded(9, 2);
        verify(channel, never()).basicNack(anyLong(), anyBoolean(), anyBoolean());
    }

    @Test
    void repairBuildsMissedSnapshotsWithoutRabbitMqAndContinuesAfterOneFailure() {
        when(persistence.snapshotCandidates(2, 0, 100)).thenReturn(List.of(8L, 9L));
        doThrow(new DataAccessResourceFailureException("transient")).when(persistence).saveSnapshotIfNeeded(8, 2);

        queue.repairMissedSnapshots();

        verify(persistence).saveSnapshotIfNeeded(8, 2);
        verify(persistence).saveSnapshotIfNeeded(9, 2);
        verifyNoInteractions(publisher);
    }

    @Test
    void repairContinuesAfterTheLastIdAndWrapsAtTheEnd() {
        when(persistence.snapshotCandidates(2, 0, 100)).thenReturn(LongStream.rangeClosed(1, 100).boxed().toList());
        when(persistence.snapshotCandidates(2, 100, 100)).thenReturn(List.of(200L));
        var order = inOrder(persistence);

        queue.repairMissedSnapshots();
        queue.repairMissedSnapshots();
        queue.repairMissedSnapshots();

        order.verify(persistence).snapshotCandidates(2, 0, 100);
        order.verify(persistence).snapshotCandidates(2, 100, 100);
        order.verify(persistence).saveSnapshotIfNeeded(200, 2);
        order.verify(persistence).snapshotCandidates(2, 0, 100);
    }

    private Message message(Object payload) throws Exception {
        return message(mapper.writeValueAsBytes(payload));
    }

    private Message message(byte[] body) {
        MessageProperties properties = new MessageProperties();
        properties.setDeliveryTag(17);
        return new Message(body, properties);
    }
}
