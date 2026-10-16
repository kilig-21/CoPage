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
    void registrationRejectsInternalIsoControlsInUsernameBeforeAnyDatabaseAccess() {
        UserAccountMapper mapper = mock(UserAccountMapper.class);
        AuthService service = new AuthService(mapper, SECRET, 24);
        for (int code = 0; code <= 0x9f; code++) {
            if (!Character.isISOControl(code)) continue;
            String username = "用户" + (char) code + "名称";
            var rejected = assertThrows(BizException.class,
                    () -> service.register(username, "123456", "昵称"), "用户名控制字符 U+%04X".formatted(code));
            assertEquals(ErrorCode.PARAM_ERROR, rejected.getErrorCode());
        }
        verifyNoInteractions(mapper);
    }

    @Test
    void registrationRejectsInternalIsoControlsInNicknameBeforeAnyDatabaseAccess() {
        UserAccountMapper mapper = mock(UserAccountMapper.class);
        AuthService service = new AuthService(mapper, SECRET, 24);
        for (int code = 0; code <= 0x9f; code++) {
            if (!Character.isISOControl(code)) continue;
            String nickname = "显示" + (char) code + "昵称";
            var rejected = assertThrows(BizException.class,
                    () -> service.register("newuser", "123456", nickname), "昵称控制字符 U+%04X".formatted(code));
            assertEquals(ErrorCode.PARAM_ERROR, rejected.getErrorCode());
        }
        verifyNoInteractions(mapper);
    }

    @Test
    void registrationPreservesUnicodeTrimAndExistingFiftyCharacterLimits() {
        UserAccountMapper mapper = mock(UserAccountMapper.class);
        AtomicReference<UserAccount> inserted = new AtomicReference<>();
        when(mapper.insert(any(UserAccount.class))).thenAnswer(call -> {
            UserAccount user = call.getArgument(0);
            user.setId(7L); inserted.set(user); return 1;
        });
        AuthService service = new AuthService(mapper, SECRET, 24);
        String username = "中文é" + "名".repeat(45) + "😀";
        String nickname = "昵称·" + "字".repeat(45) + "😀";
        assertEquals(50, username.length()); assertEquals(50, nickname.length());
        var created = service.register(" \t" + username + "\n ", "123456", " \t" + nickname + "\r ");
        assertEquals(username, created.username()); assertEquals(nickname, created.nickname());
        assertEquals(username, inserted.get().getUsername()); assertEquals(nickname, inserted.get().getNickname());
        clearInvocations(mapper);
        for (String invalidUsername : new String[]{"ab", username + "字"})
            assertEquals(ErrorCode.PARAM_ERROR,
                    assertThrows(BizException.class, () -> service.register(invalidUsername, "123456", "昵称")).getErrorCode());
        assertEquals(ErrorCode.PARAM_ERROR,
                assertThrows(BizException.class, () -> service.register("newuser", "123456", nickname + "字")).getErrorCode());
        verifyNoInteractions(mapper);
    }

    @Test
    void registrationKeepsNullAndBlankNicknameFallbackToNormalizedUsername() {
        UserAccountMapper mapper = mock(UserAccountMapper.class);
        AuthService service = new AuthService(mapper, SECRET, 24);
        for (String nickname : new String[]{null, "", "  ", "\t\n"}) {
            var created = service.register(" 中文用户 ", "123456", nickname);
            assertEquals("中文用户", created.username()); assertEquals("中文用户", created.nickname());
        }
        verify(mapper, times(4)).insert(any(UserAccount.class));
    }

    @Test
    void loginStillAcceptsAnExistingAccountWithoutApplyingNewRegistrationValidation() {
        UserAccountMapper mapper = mock(UserAccountMapper.class);
        UserAccount legacy = new UserAccount();
        legacy.setId(9L); legacy.setUsername("legacy\nuser"); legacy.setNickname("既有\t昵称");
        legacy.setPassword(new BCryptPasswordEncoder().encode("123456"));
        when(mapper.selectOne(any())).thenReturn(legacy);
        var login = new AuthService(mapper, SECRET, 24).login(" legacy\nuser ", "123456");
        assertEquals("legacy\nuser", login.user().username());
        assertEquals("9", JwtUtil.parse(login.token(), SECRET).getSubject());
        assertEquals("既有\t昵称", JwtUtil.parse(login.token(), SECRET).get("nickname", String.class));
        verify(mapper, never()).insert(any(UserAccount.class));
    }

    @Test
    void loginRejectsOversizedPasswordWithAuthenticationError() {
        UserAccountMapper mapper = mock(UserAccountMapper.class);
        AuthService service = new AuthService(mapper, SECRET, 24);
        var error = assertThrows(BizException.class, () -> service.login("testA", "密".repeat(25)));
        assertEquals(ErrorCode.UNAUTHORIZED, error.getErrorCode());
    }
}
