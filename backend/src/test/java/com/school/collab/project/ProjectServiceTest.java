package com.school.collab.project;

import com.school.collab.common.BizException;
import com.school.collab.common.ErrorCode;
import com.school.collab.common.UserContext;
import com.school.collab.group.GroupService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import java.util.List;
import java.util.Optional;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;

class ProjectServiceTest {
    private final ProjectRepository repo=mock(ProjectRepository.class);
    private final GroupService groups=mock(GroupService.class);
    private final ProjectService service=new ProjectService(repo,groups);
    private static final String OLD="11111111-1111-4111-8111-111111111111", NEW="22222222-2222-4222-8222-222222222222";
    @AfterEach void clear() {UserContext.clear();}
    private void project(long owner,long group,boolean archived) {
        var p=new ProjectRepository.Project(10,"项目","简介",owner,group,archived);
        when(repo.find(eq(10L),anyBoolean())).thenReturn(Optional.of(p));
    }
    private void as(long id) {UserContext.set(id,"user"+id);}
    private void code(ErrorCode code,Runnable action) {assertEquals(code,assertThrows(BizException.class,action::run).getErrorCode());}

    @Test void anonymousCannotReadOrMutateAnything() {
        code(ErrorCode.UNAUTHORIZED,()->service.list("all",0,false,"",1,20));
        code(ErrorCode.UNAUTHORIZED,()->service.create("name","",0));
        code(ErrorCode.UNAUTHORIZED,()->service.detail(10,"",1,20));
        code(ErrorCode.UNAUTHORIZED,()->service.add(10,5));
        verifyNoInteractions(repo,groups);
    }
    @Test void personalCreationBindsIdentityAndNeverReadsGroupOrDocument() {
        as(7);when(repo.create("我的项目","简介",7,0)).thenReturn(20L);
        assertEquals(20,service.create(" 我的项目 "," 简介 ",0).id());
        verify(repo).create("我的项目","简介",7,0);verifyNoMoreInteractions(repo);verifyNoInteractions(groups);
    }
    @Test void invalidCreationDoesNotWrite() {
        as(1);for(String name:new String[]{null," ","项".repeat(81),"a\nb"})code(ErrorCode.PARAM_ERROR,()->service.create(name,"",0));
        code(ErrorCode.PARAM_ERROR,()->service.create("项","简".repeat(301),0));
        code(ErrorCode.PARAM_ERROR,()->service.create("项","",-1));verifyNoInteractions(repo,groups);
    }
    @Test void groupCreationRequiresCurrentManager() {
        as(2);when(groups.access(3,true)).thenReturn(new GroupService.Access(3,"组","member"));
        code(ErrorCode.FORBIDDEN,()->service.create("项目","",3));verify(repo,never()).create(anyString(),anyString(),anyLong(),anyLong());
        when(groups.access(3,true)).thenReturn(new GroupService.Access(3,"组","admin"));when(repo.create("项目","",2,3)).thenReturn(10L);
        assertEquals(3,service.create("项目","",3).groupId());verify(groups,times(2)).access(3,true);
    }
    @Test void listValidatesScopePagingAndExplicitGroupMembership() {
        as(2);for(String scope:new String[]{null,"bad"})code(ErrorCode.PARAM_ERROR,()->service.list(scope,0,false,"",1,20));
        code(ErrorCode.PARAM_ERROR,()->service.list("all",0,false,"",0,20));
        code(ErrorCode.PARAM_ERROR,()->service.list("all",0,false,"",1,101));
        code(ErrorCode.PARAM_ERROR,()->service.list("all",0,false,"x".repeat(201),1,20));
        when(groups.access(3,false)).thenThrow(new BizException(ErrorCode.FORBIDDEN));
        code(ErrorCode.FORBIDDEN,()->service.list("group",3,false,"",1,20));verifyNoInteractions(repo);
    }
    @Test void anotherUserCannotReadPrivateProjectEvenWithDocumentAccess() {
        as(2);project(1,0,false);code(ErrorCode.FORBIDDEN,()->service.detail(10,"",1,20));
        verify(repo,never()).documents(anyLong(),anyLong(),anyBoolean(),anyString(),anyInt(),anyInt());
    }
    @Test void creatorLeavingGroupCannotBypassCurrentMembership() {
        as(2);project(2,3,false);when(groups.access(3,false)).thenThrow(new BizException(ErrorCode.FORBIDDEN));
        code(ErrorCode.FORBIDDEN,()->service.detail(10,"",1,20));verify(repo,never()).documentCount(anyLong(),anyLong(),anyString());
    }
    @Test void memberCanReadFilteredGroupDocumentsButCannotRenameOrArchive() {
        as(2);project(1,3,false);when(groups.access(eq(3L),anyBoolean())).thenReturn(new GroupService.Access(3,"组","member"));
        when(repo.documents(10,2,false,"关键",1,20)).thenReturn(List.of());when(repo.documentCount(10,2,"关键")).thenReturn(0L);
        var detail=service.detail(10," 关键 ",1,20);assertFalse(detail.canManage());assertEquals(0,detail.total());
        verify(repo).documents(10,2,false,"关键",1,20);
        code(ErrorCode.FORBIDDEN,()->service.rename(10,"改名",""));code(ErrorCode.FORBIDDEN,()->service.archive(10,true));
        verify(repo,never()).rename(anyLong(),anyString(),anyString());verify(repo,never()).archive(anyLong(),anyBoolean());
    }
    @Test void personalProjectCanOrganizeAuthorizedReadOnlyDocumentWithoutGrantOrBodyWrite() {
        as(2);project(2,0,false);when(repo.lockDocument(5,2)).thenReturn(Optional.of(new ProjectRepository.Document(5,1,1)));
        when(repo.add(10,5,2)).thenReturn(true);assertTrue(service.add(10,5).changed());
        verify(repo).add(10,5,2);verify(repo).touch(10);verifyNoInteractions(groups);
    }
    @Test void groupManagerCannotAssociateSomeoneElsesDocumentEvenIfEditable() {
        as(2);project(2,3,false);when(groups.access(3,true)).thenReturn(new GroupService.Access(3,"组","admin"));
        when(repo.lockDocument(5,2)).thenReturn(Optional.of(new ProjectRepository.Document(5,1,2)));
        code(ErrorCode.FORBIDDEN,()->service.add(10,5));verify(repo,never()).add(anyLong(),anyLong(),anyLong());
    }
    @Test void ordinaryGroupMemberCanExplicitlyAssociateOwnDocument() {
        as(2);project(1,3,false);when(groups.access(3,true)).thenReturn(new GroupService.Access(3,"组","member"));
        when(repo.lockDocument(5,2)).thenReturn(Optional.of(new ProjectRepository.Document(5,2,2)));when(repo.add(10,5,2)).thenReturn(true);
        assertTrue(service.add(10,5).changed());
        var order=inOrder(repo,groups);order.verify(repo).find(10,false);order.verify(groups).access(3,true);
        order.verify(repo).find(10,true);order.verify(repo).lockDocument(5,2);
    }
    @Test void inaccessibleOrDeletedDocumentNeverCreatesAssociation() {
        as(2);project(2,0,false);when(repo.lockDocument(5,2)).thenReturn(Optional.empty());code(ErrorCode.NOT_FOUND,()->service.add(10,5));
        when(repo.lockDocument(5,2)).thenReturn(Optional.of(new ProjectRepository.Document(5,1,0)));
        code(ErrorCode.FORBIDDEN,()->service.add(10,5));verify(repo,never()).add(anyLong(),anyLong(),anyLong());
    }
    @Test void duplicateAssociationDoesNotTouchProjectOrCreateAnotherBody() {
        as(2);project(2,0,false);when(repo.lockDocument(5,2)).thenReturn(Optional.of(new ProjectRepository.Document(5,2,2)));
        when(repo.add(10,5,2)).thenReturn(false);assertFalse(service.add(10,5).changed());verify(repo,never()).touch(anyLong());
    }
    @Test void ordinaryMemberCannotRemoveAnotherOwnersReference() {
        as(2);project(1,3,false);when(groups.access(3,true)).thenReturn(new GroupService.Access(3,"组","member"));
        when(repo.lockDocument(5,2)).thenReturn(Optional.of(new ProjectRepository.Document(5,1,1)));
        code(ErrorCode.FORBIDDEN,()->service.remove(10,5,OLD));verify(repo,never()).association(anyLong(),anyLong());
    }
    @Test void staleRemovalCannotDeleteReaddedReferenceAndRepeatIsIdempotent() {
        as(2);project(2,0,false);when(repo.lockDocument(5,2)).thenReturn(Optional.of(new ProjectRepository.Document(5,2,2)));
        when(repo.association(10,5)).thenReturn(Optional.of(NEW));code(ErrorCode.PARAM_ERROR,()->service.remove(10,5,OLD));
        verify(repo,never()).remove(anyLong(),anyLong(),anyString());
        assertTrue(service.remove(10,5,NEW).changed());verify(repo).remove(10,5,NEW);
        when(repo.association(10,5)).thenReturn(Optional.empty());assertFalse(service.remove(10,5,NEW).changed());
        verify(repo,times(1)).remove(10,5,NEW);
    }
    @Test void archivedProjectBlocksReferencesButCanBeRestoredByCurrentManager() {
        as(2);project(2,0,true);code(ErrorCode.NOT_FOUND,()->service.add(10,5));
        service.archive(10,false);verify(repo).archive(10,false);verify(repo,never()).lockDocument(anyLong(),anyLong());
    }
    @Test void candidatesAreScopedToProjectContextAndNeverIncludeBody() {
        as(2);project(1,3,false);when(groups.access(3,false)).thenReturn(new GroupService.Access(3,"组","member"));
        when(repo.candidateCount(10,2,true,"会议")).thenReturn(1L);
        when(repo.candidates(10,2,true,"会议",1,20)).thenReturn(List.of(new ProjectRepository.Candidate(5,"会议",2)));
        var result=service.candidates(10," 会议 ",1,20);assertEquals(1,result.total());assertEquals(5,result.list().getFirst().id());
        var json=new com.fasterxml.jackson.databind.ObjectMapper().valueToTree(result.list().getFirst());assertFalse(json.has("content"));
    }
}
