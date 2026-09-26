package com.school.collab.collab.store;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.collab.lock.RedisDocLock;
import com.school.collab.ot.Delta;
import org.springframework.data.redis.core.RedisOperations;
import org.springframework.data.redis.core.SessionCallback;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

import java.util.Comparator;
import java.util.List;
import java.util.Set;

/** Redis 热状态：content/revision 为字符串键，操作历史为按 revision 排序的 ZSet。 */
@Component
public class RedisDocumentStateStore implements DocumentStateStore {

    private final StringRedisTemplate redis;
    private final ObjectMapper objectMapper;
    private final RedisDocLock lock;

    public RedisDocumentStateStore(StringRedisTemplate redis, ObjectMapper objectMapper, RedisDocLock lock) {
        this.redis = redis;
        this.objectMapper = objectMapper;
        this.lock = lock;
    }

    @Override
    public CollabDocumentSnapshot snapshot(long docId) {
        String contentJson = redis.opsForValue().get(contentKey(docId));
        String revisionValue = redis.opsForValue().get(revisionKey(docId));
        Delta content = contentJson == null ? new Delta().insert("\n") : readDelta(contentJson);
        long revision = revisionValue == null ? 0 : Long.parseLong(revisionValue);
        return new CollabDocumentSnapshot(revision, content);
    }

    @Override
    public long minimumAvailableBaseRevision(long docId) {
        Set<String> first = redis.opsForZSet().range(historyKey(docId), 0, 0);
        if (first == null || first.isEmpty()) {
            return 0;
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

                return stringOperations.exec();
            }
        });
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
