package com.school.collab.collab.presence;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.collab.ws.WsSessionRegistry;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.ScanOptions;
import org.springframework.data.redis.core.Cursor;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** 每个连接一条带过期时间的 Redis 在线记录，跨实例汇总时按 userId 去重。 */
@Component
public class RedisPresenceStore {
    private static final Duration SESSION_TTL = Duration.ofSeconds(75);
    private static final String SESSIONS_PREFIX = "collab:presence:sessions:";
    private static final DefaultRedisScript<Long> PRUNE_SCRIPT = new DefaultRedisScript<>(
            "local expired = redis.call('zrangebyscore', KEYS[1], '-inf', ARGV[1]) "
                    + "if #expired == 0 then return 0 end "
                    + "redis.call('zrem', KEYS[1], unpack(expired)) "
                    + "redis.call('hdel', KEYS[2], unpack(expired)) "
                    + "return #expired", Long.class);
    private static final String[] COLORS =
            {"#2563eb", "#db2777", "#059669", "#d97706", "#7c3aed"};

    private final StringRedisTemplate redis;
    private final ObjectMapper objectMapper;

    public RedisPresenceStore(StringRedisTemplate redis, ObjectMapper objectMapper) {
        this.redis = redis;
        this.objectMapper = objectMapper;
    }

    public void join(WsSessionRegistry.SessionInfo session, String instanceId) {
        String member = member(instanceId, session.sessionId());
        redis.opsForHash().put(usersKey(session.docId()), member,
                write(new PresenceEntry(session.userId(), session.nickname())));
        redis.opsForZSet().add(sessionsKey(session.docId()), member, deadline());
    }

    public void heartbeat(WsSessionRegistry.SessionInfo session, String instanceId) {
        redis.opsForZSet().add(sessionsKey(session.docId()),
                member(instanceId, session.sessionId()), deadline());
    }

    public void leave(WsSessionRegistry.SessionInfo session, String instanceId) {
        String member = member(instanceId, session.sessionId());
        redis.opsForZSet().remove(sessionsKey(session.docId()), member);
        redis.opsForHash().delete(usersKey(session.docId()), member);
    }

    public List<PresenceUser> users(long docId) {
        String sessionsKey = sessionsKey(docId);
        String usersKey = usersKey(docId);
        pruneExpired(docId);

        Set<String> members = redis.opsForZSet().range(sessionsKey, 0, -1);
        if (members == null || members.isEmpty()) {
            return List.of();
        }
        List<Object> entries = redis.opsForHash().multiGet(usersKey, new ArrayList<>(members));
        if (entries == null) {
            return List.of();
        }
        Map<Long, PresenceUser> unique = new LinkedHashMap<>();
        for (Object raw : entries) {
            if (raw == null) {
                continue;
            }
            PresenceEntry entry = read(raw.toString());
            unique.putIfAbsent(entry.userId(), new PresenceUser(
                    entry.userId(), entry.nickname(),
                    COLORS[(int) Math.floorMod(entry.userId(), COLORS.length)]));
        }
        return List.copyOf(unique.values());
    }

    /** 原子清理，只有真正移除过期连接的实例会广播。 */
    public boolean pruneExpired(long docId) {
        Long removed = redis.execute(PRUNE_SCRIPT,
                List.of(sessionsKey(docId), usersKey(docId)),
                String.valueOf(System.currentTimeMillis()));
        return removed != null && removed > 0;
    }

    public List<Long> documentsWithPresence() {
        List<Long> ids = new ArrayList<>();
        try (Cursor<String> keys = redis.scan(ScanOptions.scanOptions()
                .match(SESSIONS_PREFIX + "*").count(100).build())) {
            while (keys.hasNext()) {
                String key = keys.next();
                try {
                    ids.add(Long.parseLong(key.substring(SESSIONS_PREFIX.length())));
                } catch (NumberFormatException ignored) {
                    // 非本协议生成的键不参与在线状态维护。
                }
            }
        }
        return ids;
    }

    private static long deadline() {
        return System.currentTimeMillis() + SESSION_TTL.toMillis();
    }

    private static String member(String instanceId, String sessionId) {
        return instanceId + ":" + sessionId;
    }

    private static String sessionsKey(long docId) {
        return SESSIONS_PREFIX + docId;
    }

    private static String usersKey(long docId) {
        return "collab:presence:users:" + docId;
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

    private record PresenceEntry(long userId, String nickname) {
    }

    public record PresenceUser(long userId, String nickname, String color) {
    }
}
