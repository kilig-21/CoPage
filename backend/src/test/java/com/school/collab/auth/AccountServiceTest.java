package com.school.collab.auth;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.common.BizException;
import com.school.collab.common.ErrorCode;
import com.school.collab.common.UserContext;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import java.util.Optional;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class AccountServiceTest {
    private final AccountRepository accounts=mock(AccountRepository.class);
    private final ApplicationEventPublisher events=mock(ApplicationEventPublisher.class);
    private final AccountService service=new AccountService(accounts,events);
    private final BCryptPasswordEncoder encoder=new BCryptPasswordEncoder(4);
    private final AccountRepository.Profile profile=new AccountRepository.Profile(5,"owner","Old",null,3);
    @BeforeEach void currentUser() { UserContext.set(5L,"owner",3); }
    @AfterEach void clear() { UserContext.clear(); }
    private void credentials() { when(accounts.lockCredentials(5L)).thenReturn(Optional.of(new AccountRepository.Credentials(profile,encoder.encode("old-password")))); }
    @Test void profileOnlyReturnsOwnPublicFields() {
        when(accounts.profile(5L)).thenReturn(Optional.of(profile));
        var result=new ObjectMapper().valueToTree(service.profile());
        assertEquals(5,result.path("id").asLong());assertEquals("owner",result.path("username").asText());
        assertFalse(result.has("password"));assertFalse(result.has("credentialVersion"));
        assertFalse(result.has("passwordHash"));verify(accounts).profile(5L);
    }
    @Test void unauthenticatedReadAndMutationsNeverReachDatabase() {
        UserContext.clear();assertThrows(BizException.class,service::profile);
        assertThrows(BizException.class,()->service.nickname("New"));
        assertThrows(BizException.class,()->service.changePassword("old-password","new-password"));
        verifyNoInteractions(accounts,events);
    }
    @Test void nicknameIsTrimmedAndOnlyCurrentAccountIsChanged() {
        credentials();var result=service.nickname(" 新昵称 ");
        assertEquals("新昵称",result.nickname());assertEquals("owner",result.username());
        verify(accounts).nickname(5,"新昵称");verify(accounts,never()).password(anyLong(),anyString(),anyLong());
        verifyNoInteractions(events);
    }
    @Test void invalidNicknameCannotWriteOrRotateCredentials() {
        for(String value:new String[]{" ","a".repeat(51),"a\nb"})assertThrows(BizException.class,()->service.nickname(value));
        verifyNoInteractions(accounts,events);
    }
    @Test void wrongOrUnchangedPasswordNeverWritesOrEmitsSessionNotification() {
        credentials();var wrong=assertThrows(BizException.class,()->service.changePassword("wrong-password","new-password"));
        assertEquals(ErrorCode.PARAM_ERROR,wrong.getErrorCode());
        assertThrows(BizException.class,()->service.changePassword("old-password","old-password"));
        verify(accounts,never()).password(anyLong(),anyString(),anyLong());verifyNoInteractions(events);
    }
    @Test void newPasswordByteLimitIsCheckedBeforeLockOrWrite() {
        for(String value:new String[]{"short","中".repeat(25),"a".repeat(65),"      "})
            assertThrows(BizException.class,()->service.changePassword("old-password",value));
        verifyNoInteractions(accounts,events);
    }
    @Test void staleAuthenticatedMutationIsRejectedAfterAcquiringUserLock() {
        credentials();UserContext.set(5L,"owner",2);
        var error=assertThrows(BizException.class,()->service.changePassword("old-password","new-password"));
        assertEquals(ErrorCode.UNAUTHORIZED,error.getErrorCode());
        assertThrows(BizException.class,()->service.nickname("New"));
        verify(accounts,never()).password(anyLong(),anyString(),anyLong());verify(accounts,never()).nickname(anyLong(),anyString());
        verifyNoInteractions(events);
    }
    @Test void successfulPasswordChangeHashesAndRotatesOnceThenEmitsNoSecrets() {
        credentials();service.changePassword("old-password","new-password");
        ArgumentCaptor<String> hash=ArgumentCaptor.forClass(String.class);
        verify(accounts).password(eq(5L),hash.capture(),eq(4L));
        assertNotEquals("new-password",hash.getValue());assertTrue(encoder.matches("new-password",hash.getValue()));
        verify(events).publishEvent(new AccountService.PasswordChanged(5));
    }
}
