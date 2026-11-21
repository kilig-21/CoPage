package com.school.collab.collab.presence;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.collab.ws.WsSessionRegistry;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Each connection has a lease. The index stores the next lease deadline per document. */
@Component
public class RedisPresenceStore {
    private static final long SESSION_TTL_MS = 75_000;
    private static final String DOCUMENT_INDEX = "collab:presence:active-docs";
    private static final String NOW = """
            local clock = redis.call('TIME')
            local now = clock[1] * 1000 + math.floor(clock[2] / 1000)
            """;
    // Each script affecting sessions calls the same index and key TTL update.
    private static final String UPDATE_INDEX = """
            local function updateIndex()
              local first = redis.call('zrange', KEYS[1], 0, 0, 'WITHSCORES')
              if #first == 0 then
                redis.call('del', KEYS[1], KEYS[2])
                redis.call('zrem', KEYS[3], ARGV[1])
              else
                local last = redis.call('zrange', KEYS[1], -1, -1, 'WITHSCORES')
                local deadline = tonumber(last[2]) + 30000
                redis.call('pexpireat', KEYS[1], deadline)
                redis.call('pexpireat', KEYS[2], deadline)
                redis.call('zadd', KEYS[3], first[2], ARGV[1])
              end
            end
            """;
    private static final DefaultRedisScript<Long> REGISTER = new DefaultRedisScript<>(NOW + UPDATE_INDEX + """
            if ARGV[5] == 'heartbeat' then
              local deadline = redis.call('zscore', KEYS[1], ARGV[2])
              if not deadline or tonumber(deadline) <= now then return 0 end
            end
            redis.call('hset', KEYS[2], ARGV[2], ARGV[3])
            redis.call('zadd', KEYS[1], now + tonumber(ARGV[4]), ARGV[2])
            updateIndex()
            return 1
            """, Long.class);
    private static final DefaultRedisScript<Long> LEAVE = new DefaultRedisScript<>(UPDATE_INDEX + """
            redis.call('zrem', KEYS[1], ARGV[2])
            redis.call('hdel', KEYS[2], ARGV[2])
            updateIndex()
            return 1
            """, Long.class);
    private static final DefaultRedisScript<Long> PRUNE = new DefaultRedisScript<>(NOW + UPDATE_INDEX + """
            local expired = redis.call('zrangebyscore', KEYS[1], '-inf', now, 'LIMIT', 0, 128)
            if #expired ~= 0 then
              redis.call('zrem', KEYS[1], unpack(expired))
              redis.call('hdel', KEYS[2], unpack(expired))
            end
            updateIndex()
            return #expired
            """, Long.class);
    private static final DefaultRedisScript<Long> CLEAR = new DefaultRedisScript<>("""
            redis.call('del', KEYS[1], KEYS[2])
            return redis.call('zrem', KEYS[3], ARGV[1])
            """, Long.class);
    private static final DefaultRedisScript<List> DUE = new DefaultRedisScript<>(NOW + """
            return redis.call('zrangebyscore', KEYS[1], '-inf', now, 'LIMIT', 0, 128)
            """, List.class);
    private static final String[] COLORS = {"#2563eb", "#db2777", "#059669", "#d97706", "#7c3aed"};

    private final StringRedisTemplate redis;
    private final ObjectMapper objectMapper;

    public RedisPresenceStore(StringRedisTemplate redis, ObjectMapper objectMapper) {
        this.redis = redis;
        this.objectMapper = objectMapper;
    }

    public void join(WsSessionRegistry.SessionInfo session, String instanceId) {
        register(session, instanceId, "join");
    }

    /** A delayed heartbeat cannot recreate keys cleared by document deletion. */
    public boolean heartbeat(WsSessionRegistry.SessionInfo session, String instanceId) {
        return register(session, instanceId, "heartbeat");
    }

    private boolean register(WsSessionRegistry.SessionInfo session, String instanceId, String action) {
        long docId = session.docId();
        return Long.valueOf(1).equals(redis.execute(REGISTER, keys(docId), Long.toString(docId),
                member(instanceId, session.sessionId()), write(new PresenceEntry(session.userId(), session.nickname())),
                Long.toString(SESSION_TTL_MS), action));
    }

    public void leave(WsSessionRegistry.SessionInfo session, String instanceId) {
        long docId = session.docId();
        redis.execute(LEAVE, keys(docId), Long.toString(docId), member(instanceId, session.sessionId()));
    }

    public void clear(long docId) {
        redis.execute(CLEAR, keys(docId), Long.toString(docId));
    }

    public List<PresenceUser> users(long docId) {
        List<String> keys = keys(docId);
        // Ignore expired members even before the bounded expiry worker gets to this document.
        Set<String> members = redis.opsForZSet().rangeByScore(keys.get(0), System.currentTimeMillis() + 1, Double.MAX_VALUE);
        if (members == null || members.isEmpty()) return List.of();
        List<Object> entries = redis.opsForHash().multiGet(keys.get(1), new ArrayList<>(members));
        if (entries == null) return List.of();
        Map<Long, PresenceUser> unique = new LinkedHashMap<>();
        for (Object raw : entries) {
            if (raw == null) continue;
            PresenceEntry entry = read(raw.toString());
            unique.putIfAbsent(entry.userId(), new PresenceUser(
                    entry.userId(), entry.nickname(), COLORS[Math.floorMod(entry.userId(), COLORS.length)]));
        }
        return List.copyOf(unique.values());
    }

    /** Only the worker that removed expired sessions broadcasts a change. */
    public boolean pruneExpired(long docId) {
        Long removed = redis.execute(PRUNE, keys(docId), Long.toString(docId));
        return removed != null && removed > 0;
    }

    public List<Long> documentsWithExpiredPresence() {
        List<?> due = redis.execute(DUE, List.of(DOCUMENT_INDEX));
        if (due == null) return List.of();
        return due.stream().map(value -> Long.parseLong(value.toString())).toList();
    }

    private static List<String> keys(long docId) {
        return List.of("collab:presence:sessions:" + docId, "collab:presence:users:" + docId, DOCUMENT_INDEX);
    }

    private static String member(String instanceId, String sessionId) {
        return instanceId + ":" + sessionId;
    }

    private String write(PresenceEntry entry) {
        try {
            return objectMapper.writeValueAsString(entry);
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException("无法序列化在线用户", exception);
        }
    }

    private PresenceEntry read(String json) {
        try {
            return objectMapper.readValue(json, PresenceEntry.class);
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException("Redis 在线用户记录已损坏", exception);
        }
    }

    private record PresenceEntry(long userId, String nickname) { }

    public record PresenceUser(long userId, String nickname, String color) { }
}
