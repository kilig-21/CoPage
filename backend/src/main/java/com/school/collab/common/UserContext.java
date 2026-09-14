package com.school.collab.common;

/**
 * 当前登录用户的请求级上下文。
 * 由 JwtInterceptor 在 preHandle 写入、afterCompletion 清理。
 * 注意：只在处理 HTTP 请求的线程内有效，不要传到子线程里用。
 */
public final class UserContext {

    private static final ThreadLocal<Long> USER_ID = new ThreadLocal<>();
    private static final ThreadLocal<String> USERNAME = new ThreadLocal<>();

    private UserContext() {
    }

    public static void set(Long userId, String username) {
        USER_ID.set(userId);
        USERNAME.set(username);
    }

    /** 当前登录用户 id；未登录时为 null。 */
    public static Long getUserId() {
        return USER_ID.get();
    }

    public static String getUsername() {
        return USERNAME.get();
    }

    public static void clear() {
        USER_ID.remove();
        USERNAME.remove();
    }
}
