package com.school.collab.auth;

import com.school.collab.common.BizException;
import com.school.collab.common.ErrorCode;
import com.school.collab.common.UserContext;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import java.nio.charset.StandardCharsets;

@Service
public class AccountService {
    private final AccountRepository accounts;
    private final ApplicationEventPublisher events;
    private final BCryptPasswordEncoder passwords = new BCryptPasswordEncoder();
    public AccountService(AccountRepository accounts, ApplicationEventPublisher events) {
        this.accounts = accounts; this.events = events;
    }
    public AuthService.UserView profile() {
        return view(accounts.profile(userId()).orElseThrow(() -> new BizException(ErrorCode.UNAUTHORIZED)));
    }
    @Transactional
    public AuthService.UserView nickname(String value) {
        long id = userId();
        String nickname = value == null ? "" : value.trim();
        if (nickname.isBlank() || nickname.length() > 50 || nickname.chars().anyMatch(Character::isISOControl))
            throw new BizException(ErrorCode.PARAM_ERROR, "昵称需要1～50个字符，不能包含控制字符");
        var current = locked(id).profile();
        accounts.nickname(id, nickname);
        return new AuthService.UserView(id, current.username(), nickname, current.avatar());
    }
    @Transactional
    public void changePassword(String currentPassword, String newPassword) {
        long id = userId();
        if (currentPassword == null || currentPassword.getBytes(StandardCharsets.UTF_8).length > 72)
            throw new BizException(ErrorCode.PARAM_ERROR, "原密码不正确");
        if (newPassword == null || newPassword.isBlank() || newPassword.length() < 6 || newPassword.length() > 64
                || newPassword.getBytes(StandardCharsets.UTF_8).length > 72)
            throw new BizException(ErrorCode.PARAM_ERROR, "新密码需要6～64个字符且UTF-8长度不超过72字节");
        var current = locked(id);
        if (!passwords.matches(currentPassword, current.passwordHash()))
            throw new BizException(ErrorCode.PARAM_ERROR, "原密码不正确");
        if (passwords.matches(newPassword, current.passwordHash()))
            throw new BizException(ErrorCode.PARAM_ERROR, "新密码不能与原密码相同");
        accounts.password(id, passwords.encode(newPassword), Math.addExact(current.profile().credentialVersion(), 1));
        events.publishEvent(new PasswordChanged(id));
    }
    private AccountRepository.Credentials locked(long id) {
        var current = accounts.lockCredentials(id).orElseThrow(() -> new BizException(ErrorCode.UNAUTHORIZED));
        if (current.profile().credentialVersion() != UserContext.getCredentialVersion())
            throw new BizException(ErrorCode.UNAUTHORIZED);
        return current;
    }
    private long userId() {
        Long id = UserContext.getUserId();
        if (id == null || id <= 0) throw new BizException(ErrorCode.UNAUTHORIZED);
        return id;
    }
    private AuthService.UserView view(AccountRepository.Profile profile) {
        return new AuthService.UserView(profile.id(), profile.username(), profile.nickname(), profile.avatar());
    }
    public record PasswordChanged(long userId) { }
}
