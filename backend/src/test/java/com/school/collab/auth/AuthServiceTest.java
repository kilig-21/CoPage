package com.school.collab.auth;

import com.school.collab.auth.mapper.UserAccountMapper;
import com.school.collab.common.BizException;
import com.school.collab.common.ErrorCode;
import com.school.collab.common.JwtUtil;
import org.junit.jupiter.api.Test;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;

import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

class AuthServiceTest {
    private static final String SECRET = "test-secret-longer-than-thirty-two-bytes";

    @Test
    void registerHashesPasswordAndNeverReturnsIt() {
        UserAccountMapper mapper = mock(UserAccountMapper.class);
        AtomicReference<UserAccount> inserted = new AtomicReference<>();
        when(mapper.insert(any(UserAccount.class))).thenAnswer(call -> {
            UserAccount user = call.getArgument(0);
            user.setId(7L);
            inserted.set(user);
            return 1;
        });

        AuthService.UserView result = new AuthService(mapper, SECRET, 24)
                .register("newuser", "123456", "新用户");

        assertEquals(7L, result.id());
        assertEquals("newuser", result.username());
        assertFalse(new BCryptPasswordEncoder().matches("wrong", inserted.get().getPassword()));
        assertTrue(new BCryptPasswordEncoder().matches("123456", inserted.get().getPassword()));
        assertFalse(result.toString().contains("123456"));
    }

    @Test
    void loginIssuesValidTokenAndRejectsWrongPassword() {
        UserAccountMapper mapper = mock(UserAccountMapper.class);
        UserAccount user = new UserAccount();
        user.setId(9L);
        user.setUsername("testA");
        user.setNickname("测试用户 A");
        user.setPassword(new BCryptPasswordEncoder().encode("123456"));
        when(mapper.selectOne(any())).thenReturn(user);
        AuthService service = new AuthService(mapper, SECRET, 24);

        AuthService.LoginView login = service.login("testA", "123456");
        assertEquals("9", JwtUtil.parse(login.token(), SECRET).getSubject());
        assertEquals("测试用户 A", JwtUtil.parse(login.token(), SECRET).get("nickname", String.class));
        assertEquals("testA", login.user().username());
        BizException rejected = assertThrows(BizException.class, () -> service.login("testA", "wrong"));
        assertEquals(ErrorCode.UNAUTHORIZED, rejected.getErrorCode());
    }

    @Test
    void duplicateUsernameIsRejected() {
        UserAccountMapper mapper = mock(UserAccountMapper.class);
        when(mapper.selectOne(any())).thenReturn(new UserAccount());
        AuthService service = new AuthService(mapper, SECRET, 24);

        BizException rejected = assertThrows(BizException.class,
                () -> service.register("testA", "123456", null));
        assertEquals(ErrorCode.PARAM_ERROR, rejected.getErrorCode());
        verify(mapper, never()).insert(any(UserAccount.class));
    }

    @Test
    void registrationRejectsPasswordsBeyondBcryptByteLimitBeforeWriting() {
        UserAccountMapper mapper = mock(UserAccountMapper.class);
        AuthService service = new AuthService(mapper, SECRET, 24);
        var error = assertThrows(BizException.class, () -> service.register("newuser", "密".repeat(25), null));
        assertEquals(ErrorCode.PARAM_ERROR, error.getErrorCode());
        verifyNoInteractions(mapper);
    }

    @Test
    void loginRejectsOversizedPasswordWithAuthenticationError() {
        UserAccountMapper mapper = mock(UserAccountMapper.class);
        AuthService service = new AuthService(mapper, SECRET, 24);
        var error = assertThrows(BizException.class, () -> service.login("testA", "密".repeat(25)));
        assertEquals(ErrorCode.UNAUTHORIZED, error.getErrorCode());
    }
}
