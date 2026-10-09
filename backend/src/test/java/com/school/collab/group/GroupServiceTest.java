package com.school.collab.group;

import com.school.collab.common.BizException;
import com.school.collab.common.ErrorCode;
import com.school.collab.common.UserContext;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import java.util.List;
import java.util.Optional;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;

class GroupServiceTest {
    private final GroupRepository repo=mock(GroupRepository.class);
    private final GroupService service=new GroupService(repo);
    private final GroupRepository.Group group=new GroupRepository.Group(10,"小组","简介",1,false);
    @AfterEach void clear() { UserContext.clear(); }
    private void as(long id,String role) { when(repo.invitationVersion(anyLong(),anyLong())).thenReturn(1L); UserContext.set(id,"user"+id);when(repo.find(eq(10L),anyBoolean())).thenReturn(Optional.of(group));when(repo.role(10,id)).thenReturn(role); }
    private void code(ErrorCode code,Runnable action) { assertEquals(code,assertThrows(BizException.class,action::run).getErrorCode()); }

    @Test void lockedProjectAccessRejectsRemovedMembershipDespiteOlderSnapshot() {
        as(2,"member");when(repo.roleForUpdate(10,2)).thenReturn(null);
        code(ErrorCode.FORBIDDEN,()->service.access(10,true));
        verify(repo).roleForUpdate(10,2);verify(repo,never()).role(10,2);
    }
    @Test void lockedProjectAccessUsesCurrentDemotionInsteadOfSnapshotAdminRole() {
        as(2,"admin");when(repo.roleForUpdate(10,2)).thenReturn("member");
        assertFalse(service.access(10,true).canManage());
        verify(repo).roleForUpdate(10,2);verify(repo,never()).role(10,2);
        assertTrue(service.access(10,false).canManage());
    }
    @Test void anonymousNeverReadsOrCreatesAnything() {
        code(ErrorCode.UNAUTHORIZED,()->service.list(false,1,20));
        code(ErrorCode.UNAUTHORIZED,()->service.create("组",""));
        code(ErrorCode.UNAUTHORIZED,()->service.detail(10));
        code(ErrorCode.UNAUTHORIZED,()->service.respond(10,true,1));
        verifyNoInteractions(repo);
    }
    @Test void creationBindsOwnerToActualIdentityAndRejectsInvalidInputBeforeWriting() {
        UserContext.set(7L,"user7");
        for(String name:new String[]{null," ","名".repeat(81),"a\nb"})code(ErrorCode.PARAM_ERROR,()->service.create(name,""));
        code(ErrorCode.PARAM_ERROR,()->service.create("组","简".repeat(301)));
        verifyNoInteractions(repo);
        when(repo.create("我的组","简介",7)).thenReturn(20L);
        assertEquals(20,service.create(" 我的组 "," 简介 ").id());
        verify(repo).add(20,7,"owner");
    }
    @Test void listAndInboxAreScopedAndBounded() {
        UserContext.set(2L,"member");when(repo.list(2,false,1,20)).thenReturn(List.of());when(repo.inbox(2,1,20)).thenReturn(List.of());
        assertEquals(0,service.list(false,1,20).total());assertEquals(0,service.inbox(1,20).total());
        for(int[] args:new int[][]{{0,20},{1,101},{1000001,20}})code(ErrorCode.PARAM_ERROR,()->service.list(false,args[0],args[1]));
        verify(repo).list(2,false,1,20);verify(repo).inbox(2,1,20);
    }
    @Test void nonMemberCannotReadRosterOrCreateInvitation() {
        as(3,null);code(ErrorCode.FORBIDDEN,()->service.detail(10));code(ErrorCode.FORBIDDEN,()->service.invite(10,"member"));
        verify(repo,never()).members(anyLong());verify(repo,never()).account(anyString());
    }
    @Test void ordinaryMemberSeesRosterButNotPendingInvitationsAndCannotManage() {
        as(2,"member");when(repo.members(10)).thenReturn(List.of());assertTrue(service.detail(10).invitations().isEmpty());
        verify(repo,never()).pending(anyLong());code(ErrorCode.FORBIDDEN,()->service.invite(10,"other"));
        code(ErrorCode.FORBIDDEN,()->service.rename(10,"name",""));code(ErrorCode.FORBIDDEN,()->service.changeRole(10,2,"admin"));
        code(ErrorCode.FORBIDDEN,()->service.archive(10,true));
    }
    @Test void invitationIsPendingOnlyAndRepeatDoesNotGrantMembership() {
        as(1,"owner");when(repo.account("peer")).thenReturn(Optional.of(new GroupRepository.Account(2,"peer")));
        service.invite(10," peer ");verify(repo).invite(10,2,1);verify(repo,never()).add(eq(10L),eq(2L),anyString());
        when(repo.invitation(10,2)).thenReturn("pending");service.invite(10,"peer");verify(repo,times(1)).invite(10,2,1);
    }
    @Test void capacityIncludesPendingAndNeverCreatesInvitationPastLimit() {
        as(1,"owner");when(repo.account("peer")).thenReturn(Optional.of(new GroupRepository.Account(2,"peer")));
        when(repo.memberCount(10)).thenReturn(199L);when(repo.pendingCount(10)).thenReturn(1L);
        code(ErrorCode.PARAM_ERROR,()->service.invite(10,"peer"));verify(repo,never()).invite(anyLong(),anyLong(),anyLong());
    }
    @Test void onlyInvitedIdentityCanAcceptAndAcceptedReplayCannotRejoinAfterRemoval() {
        as(2,null);code(ErrorCode.NOT_FOUND,()->service.respond(10,true,1));verify(repo,never()).add(anyLong(),anyLong(),anyString());
        when(repo.invitation(10,2)).thenReturn("pending");service.respond(10,true,1);verify(repo).add(10,2,"member");verify(repo).invitationStatus(10,2,"accepted");
        when(repo.invitation(10,2)).thenReturn("accepted");when(repo.role(10,2)).thenReturn("member");service.respond(10,true,1);verify(repo,times(1)).add(10,2,"member");
        when(repo.role(10,2)).thenReturn(null);code(ErrorCode.NOT_FOUND,()->service.respond(10,true,1));verify(repo,times(1)).add(10,2,"member");
    }
    @Test void declineNeverCreatesMembershipAndCancelRequiresManager() {
        as(2,null);when(repo.invitation(10,2)).thenReturn("pending");service.respond(10,false,1);
        verify(repo).invitationStatus(10,2,"declined");verify(repo,never()).add(anyLong(),anyLong(),anyString());
        when(repo.invitation(10,2)).thenReturn("declined");service.respond(10,false,1);verify(repo,times(1)).invitationStatus(10,2,"declined");
        as(2,"member");code(ErrorCode.FORBIDDEN,()->service.cancelInvitation(10,3,1));
    }
    @Test void roleChangesProtectCreatorAndOnlyOwnerCanPromote() {
        as(2,"admin");code(ErrorCode.FORBIDDEN,()->service.changeRole(10,2,"owner"));
        as(1,"owner");for(String role:new String[]{null,"owner","superadmin"})code(ErrorCode.PARAM_ERROR,()->service.changeRole(10,2,role));
        code(ErrorCode.PARAM_ERROR,()->service.changeRole(10,1,"member"));when(repo.role(10,2)).thenReturn("member");
        service.changeRole(10,2,"admin");verify(repo).role(10,2,"admin");verify(repo,never()).role(10,1,"member");
    }
    @Test void adminCannotRemoveOtherAdminOrOwnerButCanRemoveMember() {
        as(2,"admin");when(repo.role(10,3)).thenReturn("admin");code(ErrorCode.FORBIDDEN,()->service.remove(10,3));
        code(ErrorCode.PARAM_ERROR,()->service.remove(10,1));code(ErrorCode.PARAM_ERROR,()->service.remove(10,2));
        when(repo.role(10,3)).thenReturn("member");service.remove(10,3);verify(repo).remove(10,3);
    }
    @Test void ownerCannotLeaveAndFormerMemberCannotManage() {
        as(1,"owner");code(ErrorCode.PARAM_ERROR,()->service.leave(10));verify(repo,never()).remove(anyLong(),anyLong());
        as(2,"member");service.leave(10);verify(repo).remove(10,2);
        when(repo.role(10,2)).thenReturn(null);code(ErrorCode.FORBIDDEN,()->service.detail(10));code(ErrorCode.FORBIDDEN,()->service.invite(10,"other"));
    }
    @Test void staleResponseCannotJoinAReissuedInvitation() {
        as(2,null); when(repo.invitationVersion(10,2)).thenReturn(2L);
        when(repo.invitation(10,2)).thenReturn("pending");
        code(ErrorCode.PARAM_ERROR,()->service.respond(10,true,1));
        verify(repo,never()).add(anyLong(),anyLong(),anyString());
        service.respond(10,true,2); verify(repo).add(10,2,"member");
    }
    @Test void staleCancellationCannotCancelANewInvitation() {
        as(1,"owner"); when(repo.invitationVersion(10,3)).thenReturn(2L);
        when(repo.invitation(10,3)).thenReturn("pending");
        code(ErrorCode.PARAM_ERROR,()->service.cancelInvitation(10,3,1));
        verify(repo,never()).invitationStatus(anyLong(),anyLong(),anyString());
        service.cancelInvitation(10,3,2); verify(repo).invitationStatus(10,3,"cancelled");
    }
    @Test void archivedGroupRejectsJoiningAndCanOnlyBeRestoredByOwner() {
        var archived=new GroupRepository.Group(10,"组","",1,true);as(2,"member");when(repo.find(eq(10L),anyBoolean())).thenReturn(Optional.of(archived));
        code(ErrorCode.NOT_FOUND,()->service.respond(10,true,1));code(ErrorCode.NOT_FOUND,()->service.detail(10));
        code(ErrorCode.FORBIDDEN,()->service.archive(10,false));UserContext.set(1L,"owner");service.archive(10,false);verify(repo).archive(10,false);
    }
}
