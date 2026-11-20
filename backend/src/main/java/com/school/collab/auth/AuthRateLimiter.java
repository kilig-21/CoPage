package com.school.collab.auth;

import com.school.collab.common.BizException;
import com.school.collab.common.ErrorCode;
import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.dao.DataAccessException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.stereotype.Component;

import java.net.InetAddress;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.text.Normalizer;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.stream.Collectors;

@Component
@EnableConfigurationProperties(AuthRateLimiter.Settings.class)
public class AuthRateLimiter {
    private static final Logger log = LoggerFactory.getLogger(AuthRateLimiter.class);
    private static final DefaultRedisScript<Long> TRY_REQUEST = new DefaultRedisScript<>("""
            local threshold = tonumber(ARGV[4])
            if threshold > 0 and tonumber(redis.call('GET', KEYS[3]) or '0') >= threshold then
                return -math.max(redis.call('PTTL', KEYS[3]), 1)
            end
            local wait = 0
            for i=1,2 do
                if tonumber(redis.call('GET', KEYS[i]) or '0') >= tonumber(ARGV[i]) then
                    wait = math.max(wait, redis.call('PTTL', KEYS[i]), 1)
                end
            end
            if wait > 0 then return wait end
            for i=1,2 do
                if redis.call('INCR', KEYS[i]) == 1 then redis.call('PEXPIRE', KEYS[i], ARGV[3]) end
            end
            return 0
            """, Long.class);
    private static final DefaultRedisScript<Long> RECORD_FAILURE = new DefaultRedisScript<>("""
            local count = tonumber(redis.call('GET', KEYS[1]) or '0')
            local threshold = tonumber(ARGV[1])
            if count >= threshold then return -math.max(redis.call('PTTL', KEYS[1]), 1) end
            count = redis.call('INCR', KEYS[1])
            if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
            if count == threshold then
                redis.call('PEXPIRE', KEYS[1], ARGV[3])
                return tonumber(ARGV[3])
            end
            return 0
            """, Long.class);

    private final StringRedisTemplate redis;
    private final Settings settings;
    private final Set<String> trustedProxies;

    AuthRateLimiter(StringRedisTemplate redis, Settings settings) {
        this.redis = redis;
        this.settings = settings;
        this.trustedProxies = settings.trustedProxies().stream().map(value -> {
            String ip = canonicalIp(value.trim());
            if (ip == null) throw new IllegalArgumentException("AUTH_LIMIT_TRUSTED_PROXIES 只接受精确 IP 地址");
            return ip;
        }).collect(Collectors.toUnmodifiableSet());
    }

    String allowLogin(HttpServletRequest request, String username) {
        return allow(request, username, "login", settings.login(), settings.failureAttempts());
    }

    void allowRegistration(HttpServletRequest request, String username) {
        allow(request, username, "register", settings.registration(), 0);
    }

    private String allow(HttpServletRequest request, String username, String action, Window window, long failures) {
        String ip = clientIp(request);
        String prefix = "copage:auth:{" + action + "}:";
        String client = prefix + "ip:" + digest(ip);
        String pair = prefix + "pair:" + digest(ip + '\n' + canonicalAccount(username));
        String failureKey = pair + ":failures";
        long wait = run(TRY_REQUEST, List.of(client, pair, failureKey), window.ipLimit(),
                window.accountIpLimit(), millis(window.seconds()), failures);
        if (wait < 0) throw blocked(-wait, "登录失败次数过多");
        if (wait > 0) throw blocked(wait, "register".equals(action) ? "注册请求过于频繁" : "登录请求过于频繁");
        return failureKey;
    }

    void loginFailed(String failureKey) {
        long wait = run(RECORD_FAILURE, List.of(failureKey), settings.failureAttempts(),
                millis(settings.failureWindowSeconds()), millis(settings.lockSeconds()));
        if (wait != 0) {
            if (wait > 0) log.info("登录触发短时失败锁定");
            throw blocked(Math.abs(wait), "登录失败次数过多");
        }
    }

    void loginSucceeded(String failureKey) {
        try {
            redis.delete(failureKey);
        } catch (DataAccessException failure) {
            log.warn("认证限流状态暂时不可用");
        }
    }

    private long run(DefaultRedisScript<Long> script, List<String> keys, long... args) {
        try {
            String[] values = java.util.Arrays.stream(args).mapToObj(Long::toString).toArray(String[]::new);
            Long result = redis.execute(script, keys, (Object[]) values);
            if (result != null) return result;
        } catch (DataAccessException failure) {
            log.warn("认证限流状态暂时不可用");
        }
        throw new BizException(ErrorCode.SERVICE_UNAVAILABLE, "认证服务暂不可用，请稍后重试");
    }

    private String clientIp(HttpServletRequest request) {
        String peer = canonicalIp(request.getRemoteAddr());
        if (peer == null) return "unknown";
        if (trustedProxies.contains(peer)) {
            // Nginx 模板覆盖此头部。只接受来自已配置直接对端的单个 IP。
            String forwarded = canonicalIp(request.getHeader("X-Forwarded-For"));
            if (forwarded != null && java.util.Collections.list(request.getHeaders("X-Forwarded-For")).size() == 1) {
                return forwarded;
            }
        }
        return peer;
    }

    private static String canonicalIp(String value) {
        if (value == null || !value.matches("[0-9a-fA-F:.]{1,45}")
                || (!value.contains(":") && !value.matches("[0-9]{1,3}(\\.[0-9]{1,3}){3}"))) return null;
        try {
            return InetAddress.getByName(value).getHostAddress();
        } catch (UnknownHostException ignored) {
            return null;
        }
    }

    private static String canonicalAccount(String username) {
        return Normalizer.normalize(username.trim().toLowerCase(Locale.ROOT), Normalizer.Form.NFKD)
                .replaceAll("\\p{M}", "");
    }

    private static String digest(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException failure) {
            throw new IllegalStateException("SHA-256 不可用", failure);
        }
    }

    private static long millis(int seconds) { return 1000L * seconds; }

    private static Limited blocked(long millis, String reason) {
        long seconds = (millis + 999) / 1000;
        return new Limited(seconds, reason + "，请在 " + seconds + " 秒后重试");
    }

    static final class Limited extends RuntimeException {
        private final long retryAfter;

        Limited(long retryAfter, String message) {
            super(message);
            this.retryAfter = retryAfter;
        }

        long retryAfter() { return retryAfter; }
    }

    @ConfigurationProperties("collab.auth-limit")
    public record Settings(Window login, Window registration, int failureAttempts, int failureWindowSeconds,
                           int lockSeconds, List<String> trustedProxies) {
        public Settings {
            if (failureAttempts < 1 || failureWindowSeconds < 1 || lockSeconds < 1) {
                throw new IllegalArgumentException("认证失败阈值和时间窗必须大于零");
            }
            trustedProxies = trustedProxies == null ? List.of() : List.copyOf(trustedProxies);
        }
    }

    public record Window(int ipLimit, int accountIpLimit, int seconds) {
        public Window {
            if (ipLimit < accountIpLimit || accountIpLimit < 1 || seconds < 1) {
                throw new IllegalArgumentException("认证限流要求 IP 阈值不低于账号/IP 阈值，时间窗必须大于零");
            }
        }
    }
}
