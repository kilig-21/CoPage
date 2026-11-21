package com.school.collab.collab.store;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.collab.lock.RedisDocLock;
import com.school.collab.ot.Delta;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.redis.core.RedisOperations;
import org.springframework.data.redis.core.SessionCallback;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.time.Instant;
import java.util.Comparator;
import java.util.List;
import java.util.Set;

/** Redis caches MySQL-persisted content, revision and operations under the same deadline. */
@Component
public class RedisDocumentStateStore implements DocumentStateStore {
    private static final DefaultRedisScript<Long> EXPIRE_DURABLE = new DefaultRedisScript<>("""
            if redis.call('get', KEYS[2]) ~= ARGV[1] or redis.call('pttl', KEYS[2]) ~= -1 then return 0 end
            for i = 1, #KEYS do redis.call('pexpire', KEYS[i], ARGV[2]) end
            return 1
            """, Long.class);

    private final StringRedisTemplate redis;
    private final ObjectMapper objectMapper;
    private final RedisDocLock lock;
    private final Duration ttl;

    public RedisDocumentStateStore(StringRedisTemplate redis, ObjectMapper objectMapper, RedisDocLock lock,
                                   @Value("${collab.document-cache-ttl-seconds}") long ttlSeconds) {
        if (ttlSeconds <= 0) throw new IllegalArgumentException("文档热状态 TTL 必须为正整数");
        this.redis = redis;
        this.objectMapper = objectMapper;
        this.lock = lock;
        this.ttl = Duration.ofSeconds(ttlSeconds);
    }

    @Override
    public CollabDocumentSnapshot snapshot(long docId) {
        // MGET 是单条 Redis 命令，避免两次 GET 跨过一次事务提交而读到错配版本。
        List<String> values = redis.opsForValue().multiGet(List.of(contentKey(docId), revisionKey(docId)));
        if (values == null || values.size() != 2) {
            throw new IllegalStateException("无法读取 Redis 文档状态");
        }
        String contentJson = values.get(0);
        String revisionValue = values.get(1);
        if ((contentJson == null) != (revisionValue == null)) {
            throw new IllegalStateException("Redis 文档内容与版本号不匹配");
        }
        Delta content = contentJson == null ? new Delta().insert("\n") : readDelta(contentJson);
        long revision = revisionValue == null ? 0 : Long.parseLong(revisionValue);
        return new CollabDocumentSnapshot(revision, content);
    }

    @Override
    public long minimumAvailableBaseRevision(long docId) {
        Set<String> first = redis.opsForZSet().range(historyKey(docId), 0, 0);
        if (first == null || first.isEmpty()) {
            return snapshot(docId).revision();
        }
        return readVersioned(first.iterator().next()).revision() - 1;
    }

    @Override
    public List<VersionedOperation> operationsAfter(long docId, long revision) {
        Set<String> raw = redis.opsForZSet().rangeByScore(historyKey(docId), revision + 1, Double.MAX_VALUE);
        if (raw == null) {
            return List.of();
        }
        return raw.stream()
                .map(this::readVersioned)
                .sorted(Comparator.comparingLong(VersionedOperation::revision))
                .toList();
    }

    @Override
    public void save(long docId, CollabDocumentSnapshot snapshot,
                     VersionedOperation operation, int historyLimit) {
        Instant deadline = Instant.now().plus(ttl);
        redis.execute(new SessionCallback<List<Object>>() {
            @Override
            @SuppressWarnings("unchecked")
            public <K, V> List<Object> execute(RedisOperations<K, V> operations) {
                RedisOperations<String, String> stringOperations =
                        (RedisOperations<String, String>) operations;
                stringOperations.multi();

                stringOperations.opsForValue().set(
                        contentKey(docId),
                        write(snapshot.content())
                );
                stringOperations.opsForValue().set(
                        revisionKey(docId),
                        String.valueOf(snapshot.revision())
                );
                stringOperations.opsForZSet().add(
                        historyKey(docId),
                        write(operation),
                        operation.revision()
                );

                // 从最旧端裁剪，只保留 revision 最新的 historyLimit 条操作。
                stringOperations.opsForZSet().removeRange(
                        historyKey(docId),
                        0,
                        -historyLimit - 1L
                );
                for (String key : cacheKeys(docId)) stringOperations.expireAt(key, deadline);

                return stringOperations.exec();
            }
        });
    }

    @Override
    public void expireDurableLegacyState(long docId, long hotRevision) {
        if (hotRevision > 0) {
            redis.execute(EXPIRE_DURABLE, cacheKeys(docId), Long.toString(hotRevision), Long.toString(ttl.toMillis()));
        }
    }

    /** Called under the document lock. Redis-only legacy revisions must survive a soft deletion. */
    public void evictDurableState(long docId, long mysqlRevision) {
        String hotRevision = redis.opsForValue().get(revisionKey(docId));
        if (hotRevision == null || Long.parseLong(hotRevision) <= mysqlRevision) {
            redis.unlink(cacheKeys(docId));
        }
    }

    private static List<String> cacheKeys(long docId) {
        return List.of(contentKey(docId), revisionKey(docId), historyKey(docId));
    }

    @Override
    public <T> T withDocumentLock(long docId, java.util.function.Supplier<T> action) {
        return lock.withLock(docId, action);
    }

    //<================================ 方法提取 ======================================>

    private Delta readDelta(String json) {
        try {
            return objectMapper.readValue(json, Delta.class);
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException("Redis 中的 Delta 内容损坏", exception);
        }
    }

    private VersionedOperation readVersioned(String json) {
        try {
            return objectMapper.readValue(json, VersionedOperation.class);
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException("Redis 中的操作历史损坏", exception);
        }
    }

    private String write(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException("无法序列化协同状态", exception);
        }
    }

    private static String contentKey(long docId) {
        return "collab:doc:content:" + docId;
    }

    private static String revisionKey(long docId) {
        return "collab:doc:revision:" + docId;
    }

    private static String historyKey(long docId) {
        return "collab:doc:ops:" + docId;
    }
}
