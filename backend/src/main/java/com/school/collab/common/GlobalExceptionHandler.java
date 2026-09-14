package com.school.collab.common;

import jakarta.validation.ConstraintViolationException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@RestControllerAdvice
public class GlobalExceptionHandler {
    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    @ExceptionHandler(BizException.class)
    public ResponseEntity<Result<Void>> handleBizException(BizException exception) {
        ErrorCode errorCode = exception.getErrorCode();
        return ResponseEntity.status(httpStatus(errorCode))
                .body(new Result<>(errorCode.code(), exception.getMessage(), null));
    }

    @ExceptionHandler({MethodArgumentNotValidException.class, ConstraintViolationException.class})
    public ResponseEntity<Result<Void>> handleValidationException(Exception exception) {
        return ResponseEntity.badRequest().body(Result.fail(ErrorCode.PARAM_ERROR));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<Result<Void>> handleUnexpectedException(Exception exception) {
        log.error("未处理的服务器异常", exception);
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(Result.fail(ErrorCode.INTERNAL_ERROR));
    }

    private HttpStatus httpStatus(ErrorCode errorCode) {
        return switch (errorCode) {
            case UNAUTHORIZED -> HttpStatus.UNAUTHORIZED;
            case FORBIDDEN -> HttpStatus.FORBIDDEN;
            case NOT_FOUND -> HttpStatus.NOT_FOUND;
            case PARAM_ERROR -> HttpStatus.BAD_REQUEST;
            default -> HttpStatus.CONFLICT;
        };
    }
}
