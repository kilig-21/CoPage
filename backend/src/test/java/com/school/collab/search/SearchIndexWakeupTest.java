package com.school.collab.search;

import com.school.collab.collab.persist.DocumentPersistence.ContentChanged;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.mockito.ArgumentCaptor;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.scheduling.TaskScheduler;
import org.springframework.transaction.annotation.EnableTransactionManagement;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Instant;
import java.util.concurrent.RejectedExecutionException;

import static com.school.collab.testsupport.MySqlTestDatabase.createMigrated;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class SearchIndexWakeupTest {
    private final SearchIndex index = mock(SearchIndex.class);
    private final TaskScheduler scheduler = mock(TaskScheduler.class);
    private final SearchIndexWakeup wakeup = new SearchIndexWakeup(index, scheduler);
    private final ContentChanged event = new ContentChanged();

    @Test
    @EnabledIfEnvironmentVariable(named = "COPAGE_MIGRATION_TEST_MYSQL", matches = ".+")
    void onlyASuccessfulTransactionSchedulesBackgroundWork() {
        new ApplicationContextRunner().withUserConfiguration(Transactions.class)
                .withBean(SearchIndex.class, () -> index)
                .withBean(TaskScheduler.class, () -> scheduler)
                .withBean(SearchIndexWakeup.class)
                .run(context -> {
                    var transaction = new TransactionTemplate(new DataSourceTransactionManager(createMigrated()));
                    transaction.executeWithoutResult(status -> {
                        context.publishEvent(event);
                        verifyNoInteractions(scheduler);
                        status.setRollbackOnly();
                    });
                    verifyNoInteractions(scheduler);

                    transaction.executeWithoutResult(status -> {
                        context.publishEvent(event);
                        verifyNoInteractions(scheduler);
                    });
                    verify(scheduler).schedule(any(Runnable.class), any(Instant.class));
                });
    }

    @Test
    void coalescesCommitsBeforeAndDuringABatch() {
        wakeup.contentChanged(event);
        wakeup.contentChanged(event);
        wakeup.contentChanged(event);
        var jobs = ArgumentCaptor.forClass(Runnable.class);
        verify(scheduler).schedule(jobs.capture(), any(Instant.class));
        verifyNoInteractions(index);

        doAnswer(call -> {
            wakeup.contentChanged(event);
            wakeup.contentChanged(event);
            return 1;
        }).doReturn(1).when(index).repairPending();
        jobs.getValue().run();
        verify(scheduler, times(2)).schedule(jobs.capture(), any(Instant.class));
        jobs.getValue().run();

        verify(index, times(2)).repairPending();
        verify(scheduler, times(2)).schedule(any(Runnable.class), any(Instant.class));
    }

    @Test
    void aFailedRepairLeavesSubsequentCommitsToPeriodicRepairDuringBackoff() {
        when(index.repairPending()).thenThrow(new IllegalStateException("index unavailable"));
        wakeup.contentChanged(event);
        var job = ArgumentCaptor.forClass(Runnable.class);
        verify(scheduler).schedule(job.capture(), any(Instant.class));
        job.getValue().run();
        wakeup.contentChanged(event);
        verify(scheduler).schedule(any(Runnable.class), any(Instant.class));
    }

    @Test
    void aRejectedScheduleDoesNotBlockLaterCommits() {
        when(scheduler.schedule(any(Runnable.class), any(Instant.class)))
                .thenThrow(new RejectedExecutionException()).thenReturn(null);
        wakeup.contentChanged(event);
        wakeup.contentChanged(event);

        var jobs = ArgumentCaptor.forClass(Runnable.class);
        verify(scheduler, times(2)).schedule(jobs.capture(), any(Instant.class));
        jobs.getValue().run();
        verify(index).repairPending();
    }

    @Configuration(proxyBeanMethods = false)
    @EnableTransactionManagement
    static class Transactions { }
}
