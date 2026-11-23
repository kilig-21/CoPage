package com.school.collab.search;

import com.school.collab.collab.persist.DocumentPersistence.ContentChanged;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.TaskScheduler;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionalEventListener;

import java.time.Instant;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;

/** 合并提交后的通知。索引待处理状态与补偿仍由 MySQL 和周期巡检管理。 */
@Component
class SearchIndexWakeup {
    private static final Logger log = LoggerFactory.getLogger(SearchIndexWakeup.class);
    private static final long COALESCE_MILLIS = 250;
    private static final long FAILURE_BACKOFF_SECONDS = 5;

    private final SearchIndex index;
    private final TaskScheduler scheduler;
    private final AtomicBoolean scheduled = new AtomicBoolean();
    private final AtomicBoolean requested = new AtomicBoolean();
    private volatile Instant nextWake = Instant.MIN;

    SearchIndexWakeup(SearchIndex index, TaskScheduler scheduler) {
        this.index = index;
        this.scheduler = scheduler;
    }

    @TransactionalEventListener
    public void contentChanged(ContentChanged event) {
        requested.set(true);
        schedule();
    }

    private void schedule() {
        Instant now = Instant.now();
        if (now.isBefore(nextWake) || !scheduled.compareAndSet(false, true)) return;
        try {
            scheduler.schedule(this::repair, now.plusMillis(COALESCE_MILLIS));
        } catch (RejectedExecutionException exception) {
            scheduled.set(false);
            log.warn("ES 正文索引唤醒未调度，等待定时巡检");
        }
    }

    private void repair() {
        requested.set(false);
        try {
            int count = index.repairPending();
            if (count > 0) log.debug("ES 正文索引已更新 {} 篇", count);
        } catch (RuntimeException exception) {
            nextWake = Instant.now().plusSeconds(FAILURE_BACKOFF_SECONDS);
            log.warn("ES 正文索引唤醒失败，等待定时巡检", exception);
        } finally {
            scheduled.set(false);
            if (requested.get()) schedule();
        }
    }
}
