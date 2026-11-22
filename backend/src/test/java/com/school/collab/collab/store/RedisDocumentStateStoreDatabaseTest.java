package com.school.collab.collab.store;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.collab.lock.RedisDocLock;
import com.school.collab.ot.Delta;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.data.redis.connection.RedisStandaloneConfiguration;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;

import java.time.Duration;
import java.util.concurrent.ThreadLocalRandom;

import static org.junit.jupiter.api.Assertions.*;

@EnabledIfEnvironmentVariable(named = "COPAGE_REDIS_CACHE_TEST_PORT", matches = "[0-9]+")
class RedisDocumentStateStoreDatabaseTest {
    private final long docId = ThreadLocalRandom.current().nextLong(1_000_000_000L, 9_000_000_000L);
    private final String revisionKey = "collab:doc:revision:" + docId;
    private final String contentKey = "collab:doc:content:" + docId;
    private final String historyKey = "collab:doc:ops:" + docId;
    private LettuceConnectionFactory connection;
    private StringRedisTemplate redis;
    private RedisDocumentStateStore cache;

    @BeforeEach
    void connect() {
        int port = Integer.parseInt(System.getenv("COPAGE_REDIS_CACHE_TEST_PORT"));
        connection = new LettuceConnectionFactory(new RedisStandaloneConfiguration("127.0.0.1", port));
        connection.afterPropertiesSet();
        redis = new StringRedisTemplate(connection);
        cache = new RedisDocumentStateStore(redis, new ObjectMapper(), new RedisDocLock(redis), 30);
    }

    @AfterEach
    void close() {
        if (connection != null) connection.destroy();
    }

    @Test
    void replacedLeaseAndStaleRevisionCannotOverwriteTheHotState() {
        cache.withDocumentLock(docId, () -> {
            save(4, "newer\n");
            save(3, "stale\n");
            assertEquals(4, cache.snapshot(docId).revision());
            redis.opsForValue().set(RedisDocLock.keyFor(docId), "replacement-test-lease", Duration.ofSeconds(3));
            save(5, "lost lease\n");
            assertNull(cache.quarantineAndReset(docId, new CollabDocumentSnapshot(1, new Delta().insert("old DB\n"))));
            return null;
        });
        assertEquals("replacement-test-lease", redis.opsForValue().get(RedisDocLock.keyFor(docId)));
        assertEquals("4", redis.opsForValue().get(revisionKey));
        assertEquals("newer\n", cache.snapshot(docId).content().getOps().getFirst().text());
        assertEquals(1L, redis.opsForZSet().zCard(historyKey));
    }

    @Test
    void quarantineKeepsRawCacheAndRebuildsLiveKeysWithTtl() {
        redis.opsForValue().set(revisionKey, "5", Duration.ofSeconds(30));
        redis.opsForValue().set(contentKey, "undecodable raw value", Duration.ofSeconds(30));
        redis.opsForZSet().add(historyKey, "old operation", 5);
        assertThrows(DocumentStateStore.CorruptCacheException.class, () -> cache.snapshot(docId));

        String archive = cache.withDocumentLock(docId, () -> cache.quarantineAndReset(docId,
                new CollabDocumentSnapshot(2, new Delta().insert("durable\n"))));

        assertNotNull(archive);
        assertEquals("5", redis.opsForValue().get(archive + ":revision"));
        assertEquals("undecodable raw value", redis.opsForValue().get(archive + ":content"));
        assertTrue(redis.opsForZSet().range(archive + ":ops", 0, -1).contains("old operation"));
        assertEquals(-1L, redis.getExpire(archive + ":content"));
        assertTrue(redis.getExpire(contentKey) > 0);
        assertEquals(2, cache.snapshot(docId).revision());
        assertEquals("durable\n", cache.snapshot(docId).content().getOps().getFirst().text());
        assertFalse(redis.hasKey(historyKey));
    }

    private void save(long revision, String text) {
        cache.save(docId, new CollabDocumentSnapshot(revision, new Delta().insert(text)),
                new VersionedOperation(revision, new Delta().insert(text)), 2);
    }
}
