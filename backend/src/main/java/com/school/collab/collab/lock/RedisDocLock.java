package com.school.collab.collab.lock;

import com.school.collab.collab.CollabException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.List;
import java.util.UUID;
import java.util.function.Supplier;

/** SETNX + 随机令牌 + Lua compare-and-delete，避免误删他人已续期的锁。 */
@Component
public class RedisDocLock {

    private static final Duration TTL = Duration.ofSeconds(10);
    private static final Duration WAIT_TIMEOUT = Duration.ofSeconds(1);
    private static final long RETRY_DELAY_MILLIS = 10;
    private static final DefaultRedisScript<Long> UNLOCK_SCRIPT = new DefaultRedisScript<>(
            "if redis.call('get', KEYS[1]) == ARGV[1] then "
                    + "return redis.call('del', KEYS[1]) else return 0 end",
            Long.class
    );

    private final StringRedisTemplate redis;

    public RedisDocLock(StringRedisTemplate redis) {
        this.redis = redis;
    }

    public <T> T withLock(long docId, Supplier<T> action) {
        String key = "collab:doc:lock:" + docId;
        String token = UUID.randomUUID().toString();
        long deadline = System.nanoTime() + WAIT_TIMEOUT.toNanos();
        while (!Boolean.TRUE.equals(redis.opsForValue().setIfAbsent(key, token, TTL))) {
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
        try {
            return action.get();
        } finally {
            redis.execute(UNLOCK_SCRIPT, List.of(key), token);
        }
    }
}
