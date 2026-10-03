package com.school.collab.document;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.collab.service.DocRevService;
import com.school.collab.ot.Delta;
import org.junit.jupiter.api.Test;
import java.util.List;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;

class HistoryMaintenanceTest {
    @Test void protectedDocumentIsNeverReadOrTrimmedAndBaselineIsPreparedBeforeCompaction() {
        var repo=mock(HistoryRepository.class);
        var revisions=new DocRevService();
        revisions.commit(27,0,new Delta().insert("A"));
        when(repo.maintenanceCandidates(0,50)).thenReturn(List.of(26L,27L));
        when(repo.retentionFloor(eq(27L),eq(1L),eq(30),eq(10000),eq(67108864L),anyInt())).thenReturn(1L);
        when(repo.contentAt(eq(27L),eq(1L),any())).thenReturn(new Delta().insert("A\n"));
        var job=new HistoryMaintenance(repo,revisions,new ObjectMapper(),true,30,10000,67108864,"26");
        job.maintain();
        verify(repo,never()).floor(26);
        var order=inOrder(repo);
        order.verify(repo).contentAt(eq(27L),eq(1L),any());
        order.verify(repo).compact(eq(27L),eq(1L),any());
    }
    @Test void cleanupStaysDisabledUntilRetentionPolicyApproved() {
        var repo=mock(HistoryRepository.class);
        new HistoryMaintenance(repo,new DocRevService(),new ObjectMapper(),false,30,10000,67108864,"26").maintain();
        verifyNoInteractions(repo);
    }
    @Test void deletedHistoryMaintenanceAlsoUsesTheDocumentLock() {
        var repo=mock(HistoryRepository.class);
        var revisions=spy(new DocRevService());
        when(repo.expiredDeletedCandidates(30)).thenReturn(List.of(26L,45L));
        when(repo.maintenanceCandidates(0,50)).thenReturn(List.of());
        new HistoryMaintenance(repo,revisions,new ObjectMapper(),true,30,10000,67108864,"26").maintain();
        verify(repo).compactDeleted(45,30);
        verify(repo,never()).compactDeleted(26,30);
        verify(revisions).maintenanceLock(eq(45L),any());
    }
}
