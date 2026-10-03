package com.school.collab.common;

import jakarta.validation.ConstraintViolationException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.servlet.resource.NoResourceFoundException;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;

@RestControllerAdvice
public class GlobalExceptionHandler {
    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    @ExceptionHandler(com.school.collab.collab.CollabException.class)
    public ResponseEntity<Result<Void>> handleCollabException(com.school.collab.collab.CollabException exception) {
        int code = exception.getCode();
        int status = code >= 40900 && code < 41000 ? 409 : code;
        return ResponseEntity.status(status).body(new Result<>(code, exception.getMessage(), null));
    }

    @ExceptionHandler(BizException.class)
    public ResponseEntity<Result<Void>> handleBizException(BizException exception) {
        ErrorCode errorCode = exception.getErrorCode();
        return ResponseEntity.status(httpStatus(errorCode))
                .body(new Result<>(errorCode.code(), exception.getMessage(), null));
    }

    @ExceptionHandler({
            MethodArgumentNotValidException.class,
            ConstraintViolationException.class,
            HttpMessageNotReadableException.class,
            org.springframework.web.bind.MissingServletRequestParameterException.class,
            MethodArgumentTypeMismatchException.class
    })
    public ResponseEntity<Result<Void>> handleValidationException(Exception exception) {
        return ResponseEntity.badRequest().body(Result.fail(ErrorCode.PARAM_ERROR));
    }

    /**
     * 路径写错（或接口还没实现）时，Spring 会抛 NoResourceFoundException。
     * 如果不单独接住，它会掉进下面的兜底分支变成 500「服务器内部错误」，
     * 让人误以为是自己代码崩了 —— 明明只是 URL 打错了。
     */
    @ExceptionHandler(NoResourceFoundException.class)
    public ResponseEntity<Result<Void>> handleNoResourceFound(NoResourceFoundException exception) {
        log.warn("接口不存在: {}", exception.getResourcePath());
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Result.fail(ErrorCode.NOT_FOUND));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<Result<Void>> handleUnexpectedException(Exception exception) {
        log.error("未处理的服务器异常", exception);
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(Result.fail(ErrorCode.INTERNAL_ERROR));
    }

    @ExceptionHandler(org.springframework.web.HttpRequestMethodNotSupportedException.class)
    public ResponseEntity<Result<Void>> handleUnsupportedMethod(org.springframework.web.HttpRequestMethodNotSupportedException exception) {
        return ResponseEntity.status(HttpStatus.METHOD_NOT_ALLOWED)
            .body(new Result<>(405, "该接口不支持此请求方法", null));
    }

    private HttpStatus httpStatus(ErrorCode errorCode) {
        return switch (errorCode) {
            case UNAUTHORIZED -> HttpStatus.UNAUTHORIZED;
            case FORBIDDEN -> HttpStatus.FORBIDDEN;
            case NOT_FOUND -> HttpStatus.NOT_FOUND;
            case PARAM_ERROR -> HttpStatus.BAD_REQUEST;
            case INTERNAL_ERROR -> HttpStatus.INTERNAL_SERVER_ERROR;
            default -> HttpStatus.CONFLICT;
        };
    }
}
