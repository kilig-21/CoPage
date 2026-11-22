package com.school.collab.document;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.collab.service.DocRevService;
import com.school.collab.ot.Delta;
import org.junit.jupiter.api.Test;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;

class HistoryMaintenanceTest {
    @Test void protectedDocumentIsNeverReadOrTrimmedAndBaselineIsPreparedBeforeCompaction() {
        var repo=mock(HistoryRepository.class);
        var revisions=new DocRevService();
        revisions.commit(27,0,new Delta().insert("A"));
        when(repo.maintenanceCandidates(0,50)).thenReturn(List.of(26L,27L,536L,548L));
        when(repo.retentionFloor(eq(27L),eq(1L),eq(30),eq(10000),eq(67108864L),anyInt())).thenReturn(1L);
        when(repo.contentAt(eq(27L),eq(1L),any())).thenReturn(new Delta().insert("A\n"));
        var job=new HistoryMaintenance(repo,revisions,new ObjectMapper(),true,30,10000,100,67108864,"26,536,548");
        job.maintain();
        verify(repo,never()).floor(26);
        verify(repo,never()).trimPeriodicSnapshots(longThat(id -> id == 26 || id == 536 || id == 548), anyInt());
        var order=inOrder(repo);
        order.verify(repo).trimPeriodicSnapshots(27,100);
        order.verify(repo).contentAt(eq(27L),eq(1L),any());
        order.verify(repo).compact(eq(27L),eq(1L),any());
    }
    @Test void rollbackSwitchDisablesAllAutomaticCleanup() {
        var repo=mock(HistoryRepository.class);
        new HistoryMaintenance(repo,new DocRevService(),new ObjectMapper(),false,30,10000,100,67108864,"26").maintain();
        verifyNoInteractions(repo);
    }
    @Test void deletedHistoryMaintenanceAlsoUsesTheDocumentLock() {
        var repo=mock(HistoryRepository.class);
        var revisions=spy(new DocRevService());
        when(repo.expiredDeletedCandidates(30)).thenReturn(List.of(26L,45L));
        when(repo.maintenanceCandidates(0,50)).thenReturn(List.of());
        new HistoryMaintenance(repo,revisions,new ObjectMapper(),true,30,10000,100,67108864,"26").maintain();
        verify(repo).compactDeleted(45,30);
        verify(repo,never()).compactDeleted(26,30);
        verify(revisions).maintenanceLock(eq(45L),any());
    }

    @Test
    void overlappingMaintenanceReturnsWithoutWaitingForDatabaseIo() throws Exception {
        var history = mock(HistoryRepository.class);
        var started = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        when(history.expiredDeletedCandidates(30)).thenAnswer(call -> {
            started.countDown();
            assertTrue(release.await(5, TimeUnit.SECONDS));
            return List.of();
        });
        var job = new HistoryMaintenance(history, new DocRevService(), new ObjectMapper(), true,
                30, 10000, 100, 67108864, "26");
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var first = executor.submit(job::maintain);
            try {
                assertTrue(started.await(5, TimeUnit.SECONDS));
                executor.submit(job::maintain).get(2, TimeUnit.SECONDS);
                verify(history, times(1)).expiredDeletedCandidates(30);
            } finally {
                release.countDown();
            }
            first.get(5, TimeUnit.SECONDS);
            job.maintain();
            verify(history, times(2)).expiredDeletedCandidates(30);
        }
    }
}
