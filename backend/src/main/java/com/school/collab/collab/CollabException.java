package com.school.collab.collab;

/** WebSocket 协议可预期错误，会被转成 type=error 消息。 */
public final class CollabException extends RuntimeException {

    private final int code;

    public CollabException(int code, String message) {
        super(message);
        this.code = code;
    }

    public int getCode() {
        return code;
    }
}
