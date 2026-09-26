package com.school.collab.collab.lock;

import org.junit.jupiter.api.Test;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.ValueOperations;
import org.springframework.data.redis.core.script.RedisScript;

import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class RedisDocLockTest {

    private static final Duration TEST_TTL = Duration.ofMillis(400);
    private static final Duration TEST_RENEW_INTERVAL = Duration.ofMillis(80);

    @Test
    void longActionKeepsTheLeaseAndSerializesOtherInstances() throws Exception {
        FakeRedis redis = new FakeRedis();
        RedisDocLock firstLock = new RedisDocLock(redis, TEST_TTL, TEST_RENEW_INTERVAL);
        RedisDocLock secondLock = new RedisDocLock(redis, TEST_TTL, TEST_RENEW_INTERVAL);
        CountDownLatch firstEntered = new CountDownLatch(1);
        CountDownLatch releaseFirst = new CountDownLatch(1);
        CountDownLatch secondEntered = new CountDownLatch(1);
        AtomicInteger active = new AtomicInteger();
        AtomicInteger maxActive = new AtomicInteger();

        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var first = executor.submit(() -> firstLock.withLock(7, () -> {
                maxActive.accumulateAndGet(active.incrementAndGet(), Math::max);
                firstEntered.countDown();
                try {
                    await(releaseFirst);
                    return "first";
                } finally {
                    active.decrementAndGet();
                }
            }));
            try {
                assertTrue(firstEntered.await(5, TimeUnit.SECONDS));
                // Keep the action running for several original TTL periods.
                Thread.sleep(1_000);
                var second = executor.submit(() -> secondLock.withLock(7, () -> {
                    maxActive.accumulateAndGet(active.incrementAndGet(), Math::max);
                    secondEntered.countDown();
                    active.decrementAndGet();
                    return "second";
                }));

                assertFalse(secondEntered.await(150, TimeUnit.MILLISECONDS));
                releaseFirst.countDown();
                assertEquals("first", first.get(5, TimeUnit.SECONDS));
                assertEquals("second", second.get(5, TimeUnit.SECONDS));
                assertEquals(1, maxActive.get());
            } finally {
                releaseFirst.countDown();
            }
        }
    }

    @Test
    void lostLeaseAfterActionDoesNotHideSuccessOrDeleteTheNewOwnersLock() throws Exception {
        FakeRedis redis = new FakeRedis();
        RedisDocLock lock = new RedisDocLock(redis, TEST_TTL, TEST_RENEW_INTERVAL);
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch finishAction = new CountDownLatch(1);

        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var action = executor.submit(() -> lock.withLock(7, () -> {
                entered.countDown();
                await(finishAction);
                return "done";
            }));
            try {
                assertTrue(entered.await(5, TimeUnit.SECONDS));
                redis.replaceOwner("collab:doc:lock:7", "another-instance");
                finishAction.countDown();

                assertEquals("done", action.get(5, TimeUnit.SECONDS));
                assertEquals("another-instance", redis.owner("collab:doc:lock:7"));
            } finally {
                finishAction.countDown();
            }
        }
    }

    @Test
    void unlockFailureDoesNotHideACompletedAction() {
        FakeRedis redis = new FakeRedis();
        redis.failUnlock = true;
        RedisDocLock lock = new RedisDocLock(redis, TEST_TTL, TEST_RENEW_INTERVAL);

        assertEquals("committed", lock.withLock(7, () -> "committed"));
    }

    @Test
    void finalRenewalFailureDoesNotHideACompletedAction() {
        FakeRedis redis = new FakeRedis();
        redis.failRenewal = true;
        RedisDocLock lock = new RedisDocLock(redis, TEST_TTL, TEST_RENEW_INTERVAL);

        assertEquals("committed", lock.withLock(7, () -> "committed"));
    }

    private static void await(CountDownLatch latch) {
        try {
            if (!latch.await(5, TimeUnit.SECONDS)) {
                throw new AssertionError("Timed out waiting for test action");
            }
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            throw new AssertionError(exception);
        }
    }

    private static final class FakeRedis extends StringRedisTemplate {
        private final Map<String, Lease> leases = new HashMap<>();
        private final ValueOperations<String, String> values = mock(ValueOperations.class);
        private boolean failUnlock;
        private boolean failRenewal;

        private FakeRedis() {
            when(values.setIfAbsent(anyString(), anyString(), any(Duration.class)))
                    .thenAnswer(invocation -> acquire(
                            invocation.getArgument(0), invocation.getArgument(1), invocation.getArgument(2)));
        }

        @Override
        public ValueOperations<String, String> opsForValue() {
            return values;
        }

        @Override
        @SuppressWarnings("unchecked")
        public synchronized <T> T execute(RedisScript<T> script, List<String> keys, Object... args) {
            String key = keys.getFirst();
            boolean renewal = script.getScriptAsString().contains("pexpire");
            if (renewal && failRenewal) {
                throw new IllegalStateException("Redis unavailable during renewal");
            }
            if (!renewal && failUnlock) {
                throw new IllegalStateException("Redis unavailable during unlock");
            }
            Lease current = activeLease(key);
            if (current == null || !current.token().equals(args[0])) {
                return (T) Long.valueOf(0);
            }
            if (renewal) {
                long ttlMillis = Long.parseLong((String) args[1]);
                leases.put(key, new Lease(current.token(), System.nanoTime() +
                        TimeUnit.MILLISECONDS.toNanos(ttlMillis)));
            } else {
                leases.remove(key);
            }
            return (T) Long.valueOf(1);
        }

        private synchronized boolean acquire(String key, String token, Duration ttl) {
            if (activeLease(key) != null) {
                return false;
            }
            leases.put(key, new Lease(token, System.nanoTime() + ttl.toNanos()));
            return true;
        }

        private synchronized void replaceOwner(String key, String token) {
            leases.put(key, new Lease(token, System.nanoTime() + TimeUnit.SECONDS.toNanos(5)));
        }

        private synchronized String owner(String key) {
            Lease lease = activeLease(key);
            return lease == null ? null : lease.token();
        }

        private Lease activeLease(String key) {
            Lease lease = leases.get(key);
            if (lease != null && System.nanoTime() >= lease.expiresAtNanos()) {
                leases.remove(key);
                return null;
            }
            return lease;
        }

        private record Lease(String token, long expiresAtNanos) {
        }
    }
}
