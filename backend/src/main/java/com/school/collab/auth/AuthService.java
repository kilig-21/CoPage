package com.school.collab.auth;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.school.collab.auth.mapper.UserAccountMapper;
import com.school.collab.common.BizException;
import com.school.collab.common.ErrorCode;
import com.school.collab.common.JwtUtil;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;

@Service
public class AuthService {
    private final UserAccountMapper users;
    private final BCryptPasswordEncoder passwordEncoder = new BCryptPasswordEncoder();
    private final String jwtSecret;
    private final long jwtExpireHours;

    public AuthService(
            UserAccountMapper users,
            @Value("${collab.jwt.secret}") String jwtSecret,
            @Value("${collab.jwt.expire-hours}") long jwtExpireHours
    ) {
        this.users = users;
        this.jwtSecret = jwtSecret;
        this.jwtExpireHours = jwtExpireHours;
    }

    @Transactional
    public UserView register(String username, String password, String nickname) {
        String normalizedUsername = username.trim();
        if (normalizedUsername.length() < 3 || normalizedUsername.length() > 50
                || password.length() < 6 || password.length() > 64) {
            throw new BizException(ErrorCode.PARAM_ERROR);
        }
        String normalizedNickname = nickname == null || nickname.isBlank()
                ? normalizedUsername : nickname.trim();
        if (normalizedNickname.length() > 50) {
            throw new BizException(ErrorCode.PARAM_ERROR);
        }
        if (findByUsername(normalizedUsername) != null) {
            throw new BizException(ErrorCode.PARAM_ERROR, "用户名已存在");
        }
        UserAccount user = new UserAccount();
        user.setUsername(normalizedUsername);
        user.setPassword(passwordEncoder.encode(password));
        user.setNickname(normalizedNickname);
        try {
            users.insert(user);
        } catch (DuplicateKeyException exception) {
            // 数据库唯一索引兜住并发注册竞态。
            throw new BizException(ErrorCode.PARAM_ERROR, "用户名已存在");
        }
        return view(user);
    }

    public LoginView login(String username, String password) {
        UserAccount user = findByUsername(username);
        if (user == null || !passwordEncoder.matches(password, user.getPassword())) {
            throw new BizException(ErrorCode.UNAUTHORIZED, "用户名或密码错误");
        }
        String token = JwtUtil.createToken(
                user.getId(), user.getUsername(), jwtSecret, Duration.ofHours(jwtExpireHours));
        return new LoginView(token, view(user));
    }

    private UserAccount findByUsername(String username) {
        return users.selectOne(Wrappers.<UserAccount>lambdaQuery()
                .eq(UserAccount::getUsername, username));
    }

    private UserView view(UserAccount user) {
        return new UserView(user.getId(), user.getUsername(), user.getNickname(), user.getAvatar());
    }

    public record UserView(Long id, String username, String nickname, String avatar) {
    }

    public record LoginView(String token, UserView user) {
    }
}
