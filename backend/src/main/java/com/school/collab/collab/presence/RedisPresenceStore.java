package com.school.collab.collab.presence;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.collab.ws.WsSessionRegistry;
import org.springframework.data.redis.core.StringRedisTemplate;
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
        Set<String> expired = redis.opsForZSet().rangeByScore(sessionsKey, 0, System.currentTimeMillis());
        if (expired != null && !expired.isEmpty()) {
            redis.opsForZSet().remove(sessionsKey, expired.toArray());
            redis.opsForHash().delete(usersKey, expired.toArray());
        }

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

    private static long deadline() {
        return System.currentTimeMillis() + SESSION_TTL.toMillis();
    }

    private static String member(String instanceId, String sessionId) {
        return instanceId + ":" + sessionId;
    }

    private static String sessionsKey(long docId) {
        return "collab:presence:sessions:" + docId;
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
