package com.school.collab.collab.store;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.collab.lock.RedisDocLock;
import com.school.collab.ot.Delta;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.redis.connection.DataType;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.nio.charset.StandardCharsets;
import java.util.Comparator;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/** Redis caches MySQL-persisted content, revision and operations under the same deadline. */
@Component
public class RedisDocumentStateStore implements DocumentStateStore {
    private static final Logger log = LoggerFactory.getLogger(RedisDocumentStateStore.class);
    private static final DefaultRedisScript<Long> EXPIRE_DURABLE = new DefaultRedisScript<>("""
            if redis.call('get', KEYS[2]) ~= ARGV[1] or redis.call('pttl', KEYS[2]) ~= -1 then return 0 end
            for i = 1, #KEYS do redis.call('pexpire', KEYS[i], ARGV[2]) end
            return 1
            """, Long.class);
    private static final DefaultRedisScript<Long> SAVE = new DefaultRedisScript<>("""
            if redis.call('get', KEYS[4]) ~= ARGV[1] then return 0 end
            local revisionType = redis.call('type', KEYS[2]).ok
            local historyType = redis.call('type', KEYS[3]).ok
            if (revisionType ~= 'none' and revisionType ~= 'string') or
               (historyType ~= 'none' and historyType ~= 'zset') then return -1 end
            local current = redis.call('get', KEYS[2])
            if current then
              if not string.match(current, '^%d+$') then return -1 end
              if #current > #ARGV[2] or (#current == #ARGV[2] and current >= ARGV[2]) then return 0 end
            end
            redis.call('psetex', KEYS[1], ARGV[6], ARGV[3])
            redis.call('psetex', KEYS[2], ARGV[6], ARGV[2])
            redis.call('zremrangebyscore', KEYS[3], ARGV[2], '+inf')
            redis.call('zadd', KEYS[3], ARGV[2], ARGV[4])
            redis.call('zremrangebyrank', KEYS[3], 0, -tonumber(ARGV[5]) - 1)
            redis.call('pexpire', KEYS[3], ARGV[6])
            return 1
            """, Long.class);
    private static final DefaultRedisScript<Long> QUARANTINE = new DefaultRedisScript<>("""
            if redis.call('get', KEYS[4]) ~= ARGV[1] then return 0 end
            for i = 1, 3 do
              if redis.call('exists', KEYS[i]) == 1 then
                redis.call('rename', KEYS[i], KEYS[i+4])
                redis.call('persist', KEYS[i+4])
              end
            end
            redis.call('psetex', KEYS[1], ARGV[4], ARGV[3])
            redis.call('psetex', KEYS[2], ARGV[4], ARGV[2])
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
            throw new CorruptCacheException("内容和版本缺一项");
        }
        if (revisionValue == null) {
            if (Boolean.TRUE.equals(redis.hasKey(contentKey(docId))) || Boolean.TRUE.equals(redis.hasKey(revisionKey(docId)))
                    || Boolean.TRUE.equals(redis.hasKey(historyKey(docId)))) throw new CorruptCacheException("缺少可用的内容与版本");
            return new CollabDocumentSnapshot(0, new Delta().insert("\n"));
        }
        try {
            long revision = Long.parseLong(revisionValue);
            if (revision < 0 || !Long.toString(revision).equals(revisionValue)) throw new NumberFormatException();
            return new CollabDocumentSnapshot(revision, readDelta(contentJson));
        } catch (NumberFormatException invalid) {
            throw new CorruptCacheException("版本号无效");
        }
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
    public LegacyBatch legacyOperationsAfter(long docId, long revision, int limit) {
        if (revision == Long.MAX_VALUE) return new LegacyBatch(List.of(), 0);
        var kind = redis.type(historyKey(docId));
        if (kind != DataType.NONE && kind != DataType.ZSET) throw new CorruptCacheException("热历史类型无效");
        Set<String> raw = redis.opsForZSet().rangeByScore(historyKey(docId), revision + 1, Double.MAX_VALUE, 0, limit);
        if (raw == null) return new LegacyBatch(List.of(), 0);
        long bytes = raw.stream().mapToLong(value -> value.getBytes(StandardCharsets.UTF_8).length).sum();
        return new LegacyBatch(raw.stream().map(this::readVersioned)
                .sorted(Comparator.comparingLong(VersionedOperation::revision)).toList(), bytes);
    }

    @Override
    public void save(long docId, CollabDocumentSnapshot snapshot,
                     VersionedOperation operation, int historyLimit) {
        var result = redis.execute(SAVE, List.of(contentKey(docId), revisionKey(docId), historyKey(docId), RedisDocLock.keyFor(docId)),
                lock.tokenFor(docId), Long.toString(snapshot.revision()), write(snapshot.content()), write(operation),
                Integer.toString(historyLimit), Long.toString(ttl.toMillis()));
        if (Long.valueOf(-1).equals(result)) {
            var archive = quarantineAndReset(docId, snapshot);
            log.warn("Redis 热状态类型错误，已使用 MySQL 版本, docId={}, revision={}, archive={}", docId, snapshot.revision(), archive);
        }
    }

    @Override
    public String quarantineAndReset(long docId, CollabDocumentSnapshot durable) {
        String archive = "collab:doc:quarantine:" + docId + ":" + UUID.randomUUID();
        var result = redis.execute(QUARANTINE, List.of(contentKey(docId), revisionKey(docId), historyKey(docId), RedisDocLock.keyFor(docId),
                        archive + ":content", archive + ":revision", archive + ":ops"),
                lock.tokenFor(docId), Long.toString(durable.revision()), write(durable.content()), Long.toString(ttl.toMillis()));
        return Long.valueOf(1).equals(result) ? archive : null;
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
            Delta delta = objectMapper.readValue(json, Delta.class);
            if (delta == null) throw new CorruptCacheException("热正文为空");
            return delta;
        } catch (JsonProcessingException exception) {
            throw new CorruptCacheException("热正文无法解析");
        }
    }

    private VersionedOperation readVersioned(String json) {
        try {
            VersionedOperation operation = objectMapper.readValue(json, VersionedOperation.class);
            if (operation == null || operation.operation() == null) throw new CorruptCacheException("热历史操作为空");
            return operation;
        } catch (JsonProcessingException exception) {
            throw new CorruptCacheException("热历史无法解析");
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
