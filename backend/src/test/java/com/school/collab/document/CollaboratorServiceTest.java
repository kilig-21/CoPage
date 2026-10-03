package com.school.collab.document;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.collab.ws.CollabEventBus;
import com.school.collab.common.BizException;
import com.school.collab.common.ErrorCode;
import com.school.collab.common.UserContext;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class CollaboratorServiceTest {
    private final DocumentRepository repository = mock(DocumentRepository.class);
    private final CollabEventBus events = mock(CollabEventBus.class);
    private final CollaboratorService service = new CollaboratorService(repository, events, new ObjectMapper());
    private final DocumentRepository.DocumentRow doc = new DocumentRepository.DocumentRow(
            5, "需求", "{}", 0, 1, "owner", 0, LocalDateTime.now());

    @BeforeEach
    void setup() {
        UserContext.set(1L, "owner");
        when(repository.find(5)).thenReturn(Optional.of(doc));
        when(repository.findForUpdate(5)).thenReturn(Optional.of(doc));
        TransactionSynchronizationManager.initSynchronization();
    }

    @AfterEach
    void clear() {
        UserContext.clear();
        TransactionSynchronizationManager.clearSynchronization();
    }

    @Test
    void onlyOwnerMayListInviteChangeOrRemoveEvenIfCollaboratorCanEdit() {
        UserContext.set(2L, "editor");
        when(repository.collaboratorPermission(5, 2)).thenReturn(2);
        forbidden(() -> service.list(5));
        forbidden(() -> service.invite(5, "testC", 2));
        forbidden(() -> service.change(5, 3, 1));
        forbidden(() -> service.remove(5, 3));
        verify(repository, never()).accountByUsername(anyString());
        verify(repository, never()).addCollaborator(anyLong(), anyLong(), anyInt());
        verify(repository, never()).changeCollaborator(anyLong(), anyLong(), anyInt());
        verify(repository, never()).removeCollaborator(anyLong(), anyLong());
    }

    @Test
    void inviteUsesExactRegisteredUsernameAndOnlyNotifiesAfterCommit() {
        when(repository.accountByUsername("testB")).thenReturn(Optional.of(new DocumentRepository.AccountView(2, "testB", "B")));
        service.invite(5, " testB ", 1);
        verify(repository).addCollaborator(5, 2, 1);
        verifyNoInteractions(events);
        TransactionSynchronizationManager.getSynchronizations().forEach(sync -> sync.afterCommit());
        verify(events).publish(eq(5L), eq(""), argThat(node -> node.path("userId").asLong() == 2
                && node.path("type").asText().equals("permission")));
    }

    @Test
    void duplicateInviteDoesNotOverwriteExistingPermission() {
        when(repository.accountByUsername("testB")).thenReturn(Optional.of(new DocumentRepository.AccountView(2, "testB", "B")));
        doThrow(new DuplicateKeyException("duplicate")).when(repository).addCollaborator(5, 2, 1);
        assertEquals(ErrorCode.PARAM_ERROR, assertThrows(BizException.class, () -> service.invite(5, "testB", 1)).getErrorCode());
        verify(repository, never()).changeCollaborator(anyLong(), anyLong(), anyInt());
        assertTrue(TransactionSynchronizationManager.getSynchronizations().isEmpty());
    }

    @Test
    void invalidPermissionUnknownUsernameAndOwnerCannotBeAdded() {
        assertEquals(ErrorCode.PARAM_ERROR, assertThrows(BizException.class, () -> service.invite(5, "testB", 3)).getErrorCode());
        assertEquals(ErrorCode.NOT_FOUND, assertThrows(BizException.class, () -> service.invite(5, "unknown", 1)).getErrorCode());
        when(repository.accountByUsername("owner")).thenReturn(Optional.of(new DocumentRepository.AccountView(1, "owner", "O")));
        assertEquals(ErrorCode.PARAM_ERROR, assertThrows(BizException.class, () -> service.invite(5, "owner", 2)).getErrorCode());
        verify(repository, never()).addCollaborator(anyLong(), anyLong(), anyInt());
    }

    @Test
    void changeAndRemoveRequireExistingMemberAndCannotModifyOwner() {
        when(repository.collaboratorPermission(5, 2)).thenReturn(2);
        service.change(5, 2, 1);
        service.remove(5, 2);
        verify(repository).changeCollaborator(5, 2, 1);
        verify(repository).removeCollaborator(5, 2);
        assertEquals(ErrorCode.PARAM_ERROR, assertThrows(BizException.class, () -> service.remove(5, 1)).getErrorCode());
        assertEquals(ErrorCode.NOT_FOUND, assertThrows(BizException.class, () -> service.change(5, 3, 2)).getErrorCode());
    }

    @Test
    void listReturnsMemberPublicFieldsWithoutPasswordOrToken() {
        var member = new DocumentRepository.CollaboratorView(2, "testB", "B", 1);
        when(repository.collaborators(5)).thenReturn(List.of(member));
        assertEquals(List.of(member), service.list(5));
    }

    private void forbidden(Runnable action) {
        assertEquals(ErrorCode.FORBIDDEN, assertThrows(BizException.class, action::run).getErrorCode());
    }
}
