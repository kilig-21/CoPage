package com.school.collab.common;

/** 所有 HTTP 接口统一使用的响应结构。 */
public record Result<T>(int code, String message, T data) {

    public static <T> Result<T> ok(T data) {
        return new Result<>(0, "success", data);
    }

    public static Result<Void> ok() {
        return ok(null);
    }

    public static <T> Result<T> fail(ErrorCode errorCode) {
        return new Result<>(errorCode.code(), errorCode.message(), null);
    }
}
