package com.school.collab.auth;

import com.school.collab.common.Result;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/account")
public class AccountController {
    private final AccountService accounts;
    public AccountController(AccountService accounts) { this.accounts = accounts; }
    @GetMapping("/me")
    public Result<AuthService.UserView> profile() { return Result.ok(accounts.profile()); }
    @PutMapping("/me")
    public Result<AuthService.UserView> nickname(@Valid @RequestBody NicknameRequest request) {
        return Result.ok(accounts.nickname(request.nickname()));
    }
    @PostMapping("/password")
    public Result<Void> password(@Valid @RequestBody PasswordRequest request) {
        accounts.changePassword(request.currentPassword(), request.newPassword());
        return Result.ok(null);
    }
    public record NicknameRequest(@NotBlank @Size(max=50) String nickname) { }
    public record PasswordRequest(@NotBlank @Size(max=64) String currentPassword,
                                  @NotBlank @Size(min=6,max=64) String newPassword) { }
}
