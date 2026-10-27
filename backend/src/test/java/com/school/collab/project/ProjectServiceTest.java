package com.school.collab.project;

import com.school.collab.common.BizException;
import com.school.collab.common.ErrorCode;
import com.school.collab.common.UserContext;
import com.school.collab.group.GroupService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.annotation.Transactional;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
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
        code(ErrorCode.UNAUTHORIZED,()->service.state(10));
        code(ErrorCode.UNAUTHORIZED,()->service.associationState(10,5));
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
    @Test void documentCreationLockAllowsOrdinaryGroupMemberAndLocksGroupBeforeProjectWithoutBodyAccess() {
        as(2);project(1,3,false);when(groups.access(3,true)).thenReturn(new GroupService.Access(3,"组","member"));
        service.lockForDocumentCreation(10);
        var order=inOrder(repo,groups);order.verify(repo).find(10,false);order.verify(groups).access(3,true);
        order.verify(repo).find(10,true);verifyNoMoreInteractions(repo,groups);
    }
    @Test void documentCreationLockAllowsOnlyPersonalOwnerAndRejectsArchivedOrRemovedGroupContext() {
        as(2);project(2,0,false);service.lockForDocumentCreation(10);
        project(1,0,false);code(ErrorCode.FORBIDDEN,()->service.lockForDocumentCreation(10));
        project(2,0,true);code(ErrorCode.NOT_FOUND,()->service.lockForDocumentCreation(10));
        project(1,3,false);when(groups.access(3,true)).thenThrow(new BizException(ErrorCode.FORBIDDEN));
        code(ErrorCode.FORBIDDEN,()->service.lockForDocumentCreation(10));
        verify(repo,never()).lockDocument(anyLong(),anyLong());verify(repo,never()).add(anyLong(),anyLong(),anyLong());
        verify(repo,never()).create(anyString(),anyString(),anyLong(),anyLong());
    }
    @Test void documentCreationLockRejectsAnonymousInvalidAndMissingProjectBeforeAnyFurtherAccess() {
        code(ErrorCode.UNAUTHORIZED,()->service.lockForDocumentCreation(10));verifyNoInteractions(repo,groups);
        as(2);code(ErrorCode.PARAM_ERROR,()->service.lockForDocumentCreation(0));
        code(ErrorCode.PARAM_ERROR,()->service.lockForDocumentCreation(-1));verifyNoInteractions(repo,groups);
        code(ErrorCode.NOT_FOUND,()->service.lockForDocumentCreation(10));
        verify(repo).find(10,false);verifyNoMoreInteractions(repo);verifyNoInteractions(groups);
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
        when(repo.candidates(10,2,true,"会议",1,20)).thenReturn(List.of(new ProjectRepository.Candidate(5,"会议",2,2,"成员","2026-10-18 09:10:11",true)));
        var result=service.candidates(10," 会议 ",1,20);assertEquals(1,result.total());assertEquals(5,result.list().getFirst().id());
        var json=new ObjectMapper().valueToTree(result.list().getFirst());
        var fields=new HashSet<String>();json.fieldNames().forEachRemaining(fields::add);
        assertEquals(Set.of("id","title","permission","ownerId","ownerName","updateTime","isOwner"),fields);
        assertEquals(2,json.path("permission").asInt());assertEquals(2,json.path("ownerId").asLong());assertTrue(json.path("isOwner").asBoolean());
        assertEquals("成员",json.path("ownerName").asText());assertEquals("2026-10-18 09:10:11",json.path("updateTime").asText());
        verify(repo).candidateCount(10,2,true,"会议");verify(repo).candidates(10,2,true,"会议",1,20);
    }
    @Test void personalCandidatesPreserveSharedReadOnlyMetadataAndNullableOldOwnerName() {
        as(2);project(2,0,false);
        var candidate=new ProjectRepository.Candidate(5,"同名资料",1,1,null,"2026-10-18 09:10:11",false);
        when(repo.candidateCount(10,2,false,"")).thenReturn(21L);
        when(repo.candidates(10,2,false,"",2,20)).thenReturn(List.of(candidate));
        var result=service.candidates(10,"",2,20);
        assertEquals(21,result.total());assertEquals(candidate,result.list().getFirst());
        assertTrue(new ObjectMapper().valueToTree(candidate).get("ownerName").isNull());assertFalse(candidate.isOwner());
        verify(repo).candidateCount(10,2,false,"");verify(repo).candidates(10,2,false,"",2,20);
    }
    @Test void inaccessibleAndArchivedProjectsNeverQueryCandidateMetadata() {
        code(ErrorCode.UNAUTHORIZED,()->service.candidates(10,"",1,20));verifyNoInteractions(repo,groups);
        as(2);project(1,0,false);code(ErrorCode.FORBIDDEN,()->service.candidates(10,"",1,20));
        project(2,0,true);code(ErrorCode.NOT_FOUND,()->service.candidates(10,"",1,20));
        project(1,3,false);when(groups.access(3,false)).thenThrow(new BizException(ErrorCode.FORBIDDEN));
        code(ErrorCode.FORBIDDEN,()->service.candidates(10,"",1,20));
        verify(repo,never()).candidateCount(anyLong(),anyLong(),anyBoolean(),anyString());
        verify(repo,never()).candidates(anyLong(),anyLong(),anyBoolean(),anyString(),anyInt(),anyInt());
    }
    @Test void projectStateReadsActiveAndArchivedOwnersMetadataWithoutLoadingDocuments() {
        as(2);
        for(boolean archived:new boolean[]{false,true}) {
            project(2,0,archived);
            assertEquals(new ProjectService.StateView(10,0,"项目","简介",archived,true),service.state(10));
        }
        verify(repo,times(2)).find(10,false);verifyNoMoreInteractions(repo);verifyNoInteractions(groups);
    }
    @Test void archivedGroupProjectStateUsesCurrentMemberRoleWithoutRequiringManagement() {
        as(2);project(1,3,true);when(groups.access(3,false)).thenReturn(new GroupService.Access(3,"组","member"));
        assertEquals(new ProjectService.StateView(10,3,"项目","简介",true,false),service.state(10));
        verify(repo).find(10,false);verify(groups).access(3,false);verifyNoMoreInteractions(repo,groups);
    }
    @Test void groupProjectStateReportsManagementOnlyFromCurrentRole() {
        as(2);project(1,3,false);
        when(groups.access(3,false)).thenReturn(new GroupService.Access(3,"组","admin"));
        assertTrue(service.state(10).canManage());
        when(groups.access(3,false)).thenReturn(new GroupService.Access(3,"组","member"));
        assertFalse(service.state(10).canManage());
    }
    @Test void stateEndpointsRejectInvalidIdsBeforeAnyRepositoryRead() {
        as(2);
        for(long id:new long[]{0,-1}) {
            code(ErrorCode.PARAM_ERROR,()->service.state(id));
            code(ErrorCode.PARAM_ERROR,()->service.associationState(id,5));
            code(ErrorCode.PARAM_ERROR,()->service.associationState(10,id));
        }
        verifyNoInteractions(repo,groups);
    }
    @Test void anotherOwnerCannotReadPrivateProjectStateOrProbeItsAssociation() {
        as(2);project(1,0,true);
        code(ErrorCode.FORBIDDEN,()->service.state(10));code(ErrorCode.FORBIDDEN,()->service.associationState(10,5));
        verify(repo,times(2)).find(10,false);verifyNoMoreInteractions(repo);verifyNoInteractions(groups);
    }
    @Test void missingProjectNeverReturnsAnUnlinkedAssociationState() {
        as(2);when(repo.find(10,false)).thenReturn(Optional.empty());
        code(ErrorCode.NOT_FOUND,()->service.state(10));code(ErrorCode.NOT_FOUND,()->service.associationState(10,5));
        verify(repo,times(2)).find(10,false);verifyNoMoreInteractions(repo);verifyNoInteractions(groups);
    }
    @Test void leavingOrArchivingGroupBlocksStateEvenForTheProjectCreator() {
        as(2);project(2,3,true);
        for(ErrorCode denied:new ErrorCode[]{ErrorCode.FORBIDDEN,ErrorCode.NOT_FOUND}) {
            doThrow(new BizException(denied)).when(groups).access(3,false);
            code(denied,()->service.state(10));code(denied,()->service.associationState(10,5));
        }
        verify(repo,times(4)).find(10,false);verify(groups,times(4)).access(3,false);verifyNoMoreInteractions(repo,groups);
    }
    @Test void associationStateReadsOriginalTargetWithoutFiltersAndReportsCurrentAssociation() {
        as(2);project(2,0,true);
        when(repo.findVisibleAssociationState(10,5,2)).thenReturn(
            Optional.of(new ProjectRepository.AssociationState(5,"原文档",OLD)),
            Optional.of(new ProjectRepository.AssociationState(5,"原文档",NEW)),
            Optional.of(new ProjectRepository.AssociationState(5,"原文档",null)));
        assertEquals(new ProjectService.AssociationStateView(10,5,"原文档",OLD,true),service.associationState(10,5));
        assertEquals(NEW,service.associationState(10,5).associationId());
        assertNull(service.associationState(10,5).associationId());
        verify(repo,times(3)).find(10,false);verify(repo,times(3)).findVisibleAssociationState(10,5,2);
        verifyNoMoreInteractions(repo);verifyNoInteractions(groups);
    }
    @Test void ordinaryMemberCanCheckAnAuthorizedDocumentInAnArchivedProject() {
        as(2);project(1,3,true);when(groups.access(3,false)).thenReturn(new GroupService.Access(3,"组","member"));
        when(repo.findVisibleAssociationState(10,5,2)).thenReturn(Optional.of(new ProjectRepository.AssociationState(5,"只读资料",null)));
        assertEquals(new ProjectService.AssociationStateView(10,5,"只读资料",null,true),service.associationState(10,5));
        verify(repo).find(10,false);verify(groups).access(3,false);verify(repo).findVisibleAssociationState(10,5,2);
        verifyNoMoreInteractions(repo,groups);
    }
    @Test void projectAdministratorCannotInferUnlinkedStateForAnUnreadableOrDeletedDocument() {
        as(2);project(1,3,false);when(groups.access(3,false)).thenReturn(new GroupService.Access(3,"组","admin"));
        when(repo.findVisibleAssociationState(10,5,2)).thenReturn(Optional.empty());
        code(ErrorCode.NOT_FOUND,()->service.associationState(10,5));
        verify(repo).find(10,false);verify(groups).access(3,false);verify(repo).findVisibleAssociationState(10,5,2);
        verifyNoMoreInteractions(repo,groups);
    }
    @Test void stateResponsesContainOnlyTheirPublicMetadataProjection() {
        var mapper=new ObjectMapper();
        var projectJson=mapper.valueToTree(new ProjectService.StateView(10,3,"项目","简介",true,false));
        var associationJson=mapper.valueToTree(new ProjectService.AssociationStateView(10,5,"资料",null,true));
        var projectFields=new HashSet<String>();projectJson.fieldNames().forEachRemaining(projectFields::add);
        var associationFields=new HashSet<String>();associationJson.fieldNames().forEachRemaining(associationFields::add);
        assertEquals(Set.of("id","groupId","name","description","archived","canManage"),projectFields);
        assertEquals(Set.of("projectId","docId","docTitle","associationId","projectArchived"),associationFields);
        assertTrue(associationJson.get("associationId").isNull());
    }
    @Test void bothStateReadsUseReadOnlyTransactions() throws Exception {
        assertTrue(ProjectService.class.getMethod("state",long.class).getAnnotation(Transactional.class).readOnly());
        assertTrue(ProjectService.class.getMethod("associationState",long.class,long.class).getAnnotation(Transactional.class).readOnly());
    }
    @Test void personalReplayAllowsArchivedOriginalWithoutReadingDocumentsOrMutating() {
        as(2);project(2,0,true);
        assertEquals(new ProjectService.IdView(10,0),service.replayCreation(10,0));
        verify(repo).find(10,false);verifyNoMoreInteractions(repo);verifyNoInteractions(groups);
    }
    @Test void downgradedCreatorCanReplayAnArchivedGroupProjectButCannotCreateAnother() {
        as(2);project(2,3,true);
        when(groups.access(3,false)).thenReturn(new GroupService.Access(3,"组","member"));
        when(groups.access(3,true)).thenReturn(new GroupService.Access(3,"组","member"));
        assertEquals(new ProjectService.IdView(10,3),service.replayCreation(10,3));
        code(ErrorCode.FORBIDDEN,()->service.create("项目","简介",3));
        verify(repo).find(10,false);verifyNoMoreInteractions(repo);
    }
    @Test void replayCannotBypassLeavingOrArchivingTheOriginalGroup() {
        as(2);project(2,3,true);
        for(ErrorCode denied:new ErrorCode[]{ErrorCode.FORBIDDEN,ErrorCode.NOT_FOUND}) {
            doThrow(new BizException(denied)).when(groups).access(3,false);
            code(denied,()->service.replayCreation(10,3));
        }
        verify(repo,times(2)).find(10,false);verifyNoMoreInteractions(repo);
    }
    @Test void replayRejectsMissingProjectAndUntrustedOwnerGroupOrIdWithoutReplacement() {
        as(2);code(ErrorCode.NOT_FOUND,()->service.replayCreation(10,0));
        when(groups.access(3,false)).thenReturn(new GroupService.Access(3,"组","member"));
        project(1,3,false);assertThrows(IllegalStateException.class,()->service.replayCreation(10,3));
        project(2,3,false);assertThrows(IllegalStateException.class,()->service.replayCreation(10,0));
        when(repo.find(10,false)).thenReturn(Optional.of(new ProjectRepository.Project(11,"项目","",2,3,false)));
        assertThrows(IllegalStateException.class,()->service.replayCreation(10,3));
        verify(repo,times(4)).find(10,false);verifyNoMoreInteractions(repo);
    }
    @Test void anotherPrivateOwnerAndInvalidReceiptIdsCannotReplay() {
        as(2);project(1,0,true);code(ErrorCode.FORBIDDEN,()->service.replayCreation(10,0));
        assertThrows(IllegalStateException.class,()->service.replayCreation(0,0));
        assertThrows(IllegalStateException.class,()->service.replayCreation(10,-1));
        verify(repo).find(10,false);verifyNoMoreInteractions(repo);verifyNoInteractions(groups);
    }
}
