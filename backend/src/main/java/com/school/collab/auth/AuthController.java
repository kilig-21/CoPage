package com.school.collab.auth;

import com.school.collab.common.Result;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/auth")
public class AuthController {
    private final AuthService authService;

    public AuthController(AuthService authService) {
        this.authService = authService;
    }

    @PostMapping("/register")
    public Result<AuthService.UserView> register(@Valid @RequestBody RegisterRequest request) {
        return Result.ok(authService.register(
                request.username(), request.password(), request.nickname()));
    }

    @PostMapping("/login")
    public Result<AuthService.LoginView> login(@Valid @RequestBody LoginRequest request) {
        return Result.ok(authService.login(request.username(), request.password()));
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
