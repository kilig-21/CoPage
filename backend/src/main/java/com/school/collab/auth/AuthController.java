package com.school.collab.auth;

import com.school.collab.common.BizException;
import com.school.collab.common.ErrorCode;
import com.school.collab.common.Result;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/auth")
public class AuthController {
    private final AuthService authService;
    private final AuthRateLimiter rateLimiter;

    public AuthController(AuthService authService, AuthRateLimiter rateLimiter) {
        this.authService = authService;
        this.rateLimiter = rateLimiter;
    }

    @PostMapping("/register")
    public Result<AuthService.UserView> register(@Valid @RequestBody RegisterRequest request, HttpServletRequest http) {
        rateLimiter.allowRegistration(http, request.username());
        return Result.ok(authService.register(
                request.username(), request.password(), request.nickname()));
    }

    @PostMapping("/login")
    public Result<AuthService.LoginView> login(@Valid @RequestBody LoginRequest request, HttpServletRequest http) {
        String failureKey = rateLimiter.allowLogin(http, request.username());
        try {
            AuthService.LoginView login = authService.login(request.username(), request.password());
            rateLimiter.loginSucceeded(failureKey);
            return Result.ok(login);
        } catch (BizException failure) {
            if (failure.getErrorCode() == ErrorCode.UNAUTHORIZED) rateLimiter.loginFailed(failureKey);
            throw failure;
        }
    }

    @ExceptionHandler(AuthRateLimiter.Limited.class)
    public ResponseEntity<Result<Void>> limited(AuthRateLimiter.Limited failure) {
        return ResponseEntity.status(429).header(HttpHeaders.RETRY_AFTER, Long.toString(failure.retryAfter()))
                .body(new Result<>(429, failure.getMessage(), null));
    }

    public record RegisterRequest(
            @NotBlank @Size(min = 3, max = 50) String username,
            @NotBlank @Size(min = 6, max = 64) String password,
            @Size(max = 50) String nickname
    ) {
    }

    public record LoginRequest(@NotBlank String username, @NotBlank String password) {
    }
}
