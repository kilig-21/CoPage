package com.school.collab.collab.lock;

import com.school.collab.collab.CollabException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Supplier;

/** SETNX + 随机令牌 + 按令牌续租和释放，覆盖耗时超过初始租期的文档操作。 */
@Component
public class RedisDocLock {

    private static final Logger log = LoggerFactory.getLogger(RedisDocLock.class);
    private static final Duration TTL = Duration.ofSeconds(10);
    private static final Duration RENEW_INTERVAL = TTL.dividedBy(3);
    private static final Duration WAIT_TIMEOUT = Duration.ofSeconds(1);
    private static final long RETRY_DELAY_MILLIS = 10;
    private static final DefaultRedisScript<Long> RENEW_SCRIPT = new DefaultRedisScript<>(
            "if redis.call('get', KEYS[1]) == ARGV[1] then "
                    + "return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
            Long.class
    );
    private static final DefaultRedisScript<Long> UNLOCK_SCRIPT = new DefaultRedisScript<>(
            "if redis.call('get', KEYS[1]) == ARGV[1] then "
                    + "return redis.call('del', KEYS[1]) else return 0 end",
            Long.class
    );

    private final StringRedisTemplate redis;
    private final Duration ttl;
    private final long renewIntervalMillis;

    @Autowired
    public RedisDocLock(StringRedisTemplate redis) {
        this(redis, TTL, RENEW_INTERVAL);
    }

    RedisDocLock(StringRedisTemplate redis, Duration ttl, Duration renewInterval) {
        if (ttl.toMillis() <= 0 || renewInterval.toMillis() <= 0
                || renewInterval.compareTo(ttl) >= 0) {
            throw new IllegalArgumentException("文档锁租期和续租间隔无效");
        }
        this.redis = redis;
        this.ttl = ttl;
        this.renewIntervalMillis = renewInterval.toMillis();
    }

    public <T> T withLock(long docId, Supplier<T> action) {
        String key = "collab:doc:lock:" + docId;
        String token = UUID.randomUUID().toString();
        long deadline = System.nanoTime() + WAIT_TIMEOUT.toNanos();
        while (!Boolean.TRUE.equals(redis.opsForValue().setIfAbsent(key, token, ttl))) {
            if (System.nanoTime() >= deadline) {
                throw new CollabException(40901, "文档忙，请稍后重试");
            }
            try {
                Thread.sleep(RETRY_DELAY_MILLIS);
            } catch (InterruptedException exception) {
                Thread.currentThread().interrupt();
                throw new CollabException(40901, "等待文档锁被中断");
            }
        }
        AtomicBoolean finished = new AtomicBoolean();
        AtomicBoolean lost = new AtomicBoolean();
        Thread watchdog = null;
        try {
            watchdog = Thread.ofVirtual().name("redis-doc-lock-renew-" + docId).start(() -> {
                while (!finished.get()) {
                    try {
                        Thread.sleep(renewIntervalMillis);
                    } catch (InterruptedException exception) {
                        if (!finished.get()) {
                            lost.set(true);
                        }
                        return;
                    }
                    if (finished.get()) {
                        return;
                    }
                    try {
                        if (!renew(key, token)) {
                            lost.set(true);
                            return;
                        }
                    } catch (RuntimeException exception) {
                        // Redis 的短暂故障不等于失锁；下轮继续尝试，结束时再同步确认。
                    }
                }
            });
            T result = action.get();
            // 动作可能已经持久化；完成后的失锁只能记录，不能让客户端重放已提交的操作。
            try {
                if (lost.get() || !renew(key, token)) {
                    log.warn("文档操作完成时 Redis 锁已失效, docId={}", docId);
                }
            } catch (RuntimeException exception) {
                log.warn("文档操作完成后确认 Redis 锁失败, docId={}", docId, exception);
            }
            return result;
        } finally {
            finished.set(true);
            if (watchdog != null) {
                watchdog.interrupt();
            }
            try {
                redis.execute(UNLOCK_SCRIPT, List.of(key), token);
            } catch (RuntimeException exception) {
                // 动作可能已经持久化；释放失败不能让客户端重放已提交的操作。
                log.warn("释放 Redis 文档锁失败, docId={}", docId, exception);
            }
        }
    }

    private boolean renew(String key, String token) {
        return Long.valueOf(1L).equals(redis.execute(
                RENEW_SCRIPT, List.of(key), token, String.valueOf(ttl.toMillis())));
    }
}
