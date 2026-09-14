package com.school.collab.common;

public enum ErrorCode {
    PARAM_ERROR(400, "请求参数错误"),
    UNAUTHORIZED(401, "未登录或登录已过期"),
    FORBIDDEN(403, "无权访问该资源"),
    NOT_FOUND(404, "资源不存在"),
    DOC_BUSY(40901, "文档正在处理，请稍后重试"),
    REVISION_AHEAD(40902, "客户端版本超前"),
    REVISION_TOO_OLD(40903, "版本过旧，请重新同步文档"),
    INTERNAL_ERROR(500, "服务器内部错误");

    private final int code;
    private final String message;

    ErrorCode(int code, String message) {
        this.code = code;
        this.message = message;
    }

    public int code() {
        return code;
    }

    public String message() {
        return message;
    }
}
