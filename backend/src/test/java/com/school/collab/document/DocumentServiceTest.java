package com.school.collab.document;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.common.BizException;
import com.school.collab.common.ErrorCode;
import com.school.collab.common.UserContext;
import com.school.collab.document.DocumentRepository.DocumentRow;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.time.LocalDateTime;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class DocumentServiceTest {
    private final DocumentRepository repository = mock(DocumentRepository.class);
    private final DocumentService service = new DocumentService(repository, new ObjectMapper());
    private final DocumentRow row = new DocumentRow(
            5L, "需求", "{\"ops\":[{\"insert\":\"正文\\n\"}]}", 8L,
            1L, "拥有者", 0L, LocalDateTime.of(2026, 9, 26, 15, 0));

    @AfterEach
    void clearUser() {
        UserContext.clear();
    }

    @Test
    void workbenchUsesCurrentVisibilityAndNeverLoadsBodies() {
        UserContext.set(2L, "reader");
        when(repository.countVisible(2L, "", "owned")).thenReturn(3L);
        when(repository.countVisible(2L, "", "shared")).thenReturn(1L);
        when(repository.listVisible(2L, "", "all", 1, 6)).thenReturn(java.util.List.of(
                new DocumentRepository.VisibleSummaryRow(5L, "共享资料", 1L, "拥有者", 0L, row.updateTime(), 1),
                new DocumentRepository.VisibleSummaryRow(6L, "我的资料", 2L, "reader", 0L, row.updateTime(), 2)));
        var result = service.workbench();
        assertEquals(3L, result.ownedCount());
        assertEquals(1L, result.sharedCount());
        assertFalse(result.recent().getFirst().isOwner());
        assertEquals(1, result.recent().getFirst().permission());
        assertTrue(result.recent().getLast().isOwner());
        var json = new ObjectMapper().valueToTree(result);
        assertFalse(json.get("recent").get(0).has("content"));
        assertFalse(json.get("recent").get(0).has("revision"));
        verify(repository).countVisible(2L, "", "owned");
        verify(repository).countVisible(2L, "", "shared");
        verify(repository).listVisible(2L, "", "all", 1, 6);
        verifyNoMoreInteractions(repository);
    }

    @Test
    void workbenchRequiresLoginBeforeAnyReadAndReturnsAnActualEmptyResult() {
        assertEquals(ErrorCode.UNAUTHORIZED,
                assertThrows(BizException.class, service::workbench).getErrorCode());
        verifyNoInteractions(repository);
        UserContext.set(2L, "reader");
        when(repository.listVisible(2L, "", "all", 1, 6)).thenReturn(java.util.List.of());
        var result = service.workbench();
        assertEquals(0L, result.ownedCount());
        assertEquals(0L, result.sharedCount());
        assertTrue(result.recent().isEmpty());
    }

    @Test
    void listUsesSummaryPermissionsWithoutPerDocumentLookups() {
        UserContext.set(2L, "reader");
        when(repository.countVisible(2L, "需求", "shared")).thenReturn(1L);
        when(repository.listVisible(2L, "需求", "shared", 2, 20)).thenReturn(java.util.List.of(
                new DocumentRepository.VisibleSummaryRow(5L, "需求", 1L, "拥有者", 0L, row.updateTime(), 1)));
        var result = service.list(2, 20, " 需求 ", "shared");
        assertEquals(1L, result.total());
        assertEquals(1, result.list().getFirst().permission());
        assertFalse(result.list().getFirst().isOwner());
        var json = new ObjectMapper().valueToTree(result.list().getFirst());
        assertFalse(json.has("content"));
        assertFalse(json.has("revision"));
        verify(repository).countVisible(2L, "需求", "shared");
        verify(repository).listVisible(2L, "需求", "shared", 2, 20);
        verifyNoMoreInteractions(repository);
    }

    @Test
    void listRejectsInvalidFiltersAndRequiresLoginBeforeReading() {
        for (String scope : new String[]{null, "", "other", "shared' OR 1=1"}) {
            assertEquals(ErrorCode.PARAM_ERROR,
                    assertThrows(BizException.class, () -> service.list(1, 20, "", scope)).getErrorCode());
        }
        assertEquals(ErrorCode.UNAUTHORIZED,
                assertThrows(BizException.class, () -> service.list(1, 20, "", "all")).getErrorCode());
        UserContext.set(2L, "reader");
        assertEquals(ErrorCode.PARAM_ERROR,
                assertThrows(BizException.class, () -> service.list(1, 20, "名".repeat(201), "all")).getErrorCode());
        for (int[] paging : new int[][]{{0, 20}, {1, 0}, {1, 101}}) {
            assertEquals(ErrorCode.PARAM_ERROR,
                    assertThrows(BizException.class, () -> service.list(paging[0], paging[1], "", "all")).getErrorCode());
        }
        verifyNoInteractions(repository);
    }

    @Test
    void readOnlyCopyCreatesPrivateDocumentWithFullBodyAndMatchingBaseline() {
        UserContext.set(2L, "reader");
        String rich = "{\"ops\":[{\"insert\":\"" + "大".repeat(400000) + "\"},{\"insert\":\"正文\\n\",\"attributes\":{\"bold\":true}}]}";
        var source = new DocumentRow(5L, "共享原稿", rich, 8L, 1L, "拥有者", 12L, row.updateTime());
        when(repository.findForUpdate(5L)).thenReturn(Optional.of(source));
        when(repository.collaboratorPermission(5L, 2L)).thenReturn(1);
        when(repository.create("我的副本", 2L, 0L, rich)).thenReturn(9L);
        var copied = service.copy(5, " 我的副本 ");
        assertEquals(9L, copied.id());
        assertEquals(8L, copied.sourceRevision());
        assertEquals("我的副本", copied.title());
        verify(repository).saveInitialSnapshot(9L, rich);
        verify(repository, never()).addCollaborator(anyLong(), anyLong(), anyInt());
        verify(repository, never()).rename(anyLong(), anyString());
        verify(repository, never()).softDelete(anyLong());
        verify(repository, never()).find(5L);
    }

    @Test
    void copyRequiresLoginValidSourceAndCurrentPermissionBeforeAnyWrite() {
        assertEquals(ErrorCode.UNAUTHORIZED, assertThrows(BizException.class, () -> service.copy(5, null)).getErrorCode());
        UserContext.set(3L, "stranger");
        assertEquals(ErrorCode.PARAM_ERROR, assertThrows(BizException.class, () -> service.copy(0, null)).getErrorCode());
        when(repository.findForUpdate(5L)).thenReturn(Optional.empty());
        assertEquals(ErrorCode.NOT_FOUND, assertThrows(BizException.class, () -> service.copy(5, null)).getErrorCode());
        when(repository.findForUpdate(5L)).thenReturn(Optional.of(row));
        assertEquals(ErrorCode.FORBIDDEN, assertThrows(BizException.class, () -> service.copy(5, null)).getErrorCode());
        verify(repository, never()).create(anyString(), anyLong(), anyLong(), anyString());
        verify(repository, never()).saveInitialSnapshot(anyLong(), anyString());
    }

    @Test
    void copyRejectsBlankOrOversizedExplicitTitleBeforeWriting() {
        UserContext.set(1L, "owner");
        when(repository.findForUpdate(5L)).thenReturn(Optional.of(row));
        for (String title : new String[]{" ", "名".repeat(201)}) {
            assertEquals(ErrorCode.PARAM_ERROR, assertThrows(BizException.class, () -> service.copy(5, title)).getErrorCode());
        }
        verify(repository, never()).create(anyString(), anyLong(), anyLong(), anyString());
    }

    @Test
    void copyDefaultTitleIsBoundedWithoutSplittingEmojiAndStartsFromOwnRoot() {
        UserContext.set(1L, "owner");
        String title = "标".repeat(195) + "😀" + "末".repeat(3);
        var source = new DocumentRow(5L, title, row.content(), 8L, 1L, "拥有者", 12L, row.updateTime());
        when(repository.findForUpdate(5L)).thenReturn(Optional.of(source));
        String expected = "标".repeat(195) + " 的副本";
        when(repository.create(expected, 1L, 0L, row.content())).thenReturn(9L);
        assertEquals(expected, service.copy(5, null).title());
        verify(repository).saveInitialSnapshot(9L, row.content());
    }

    @Test
    void metadataRequiresCurrentVisibilityAndNeverReturnsBody() throws Exception {
        when(repository.find(5L)).thenReturn(Optional.of(row));
        assertEquals(ErrorCode.UNAUTHORIZED, assertThrows(BizException.class, () -> service.metadata(5)).getErrorCode());
        UserContext.set(2L, "reader");
        assertEquals(ErrorCode.FORBIDDEN, assertThrows(BizException.class, () -> service.metadata(5)).getErrorCode());
        when(repository.collaboratorPermission(5L, 2L)).thenReturn(1);
        var metadata = new ObjectMapper().valueToTree(service.metadata(5));
        assertEquals(3, metadata.size());
        assertEquals("需求", metadata.get("title").asText());
        assertFalse(metadata.has("content"));
        when(repository.find(5L)).thenReturn(Optional.empty());
        assertEquals(ErrorCode.NOT_FOUND, assertThrows(BizException.class, () -> service.metadata(5)).getErrorCode());
    }

    @Test
    void renameEmitsInvalidationOnlyAfterSuccessfulWrite() {
        var publisher = mock(org.springframework.context.ApplicationEventPublisher.class);
        var withEvents = new DocumentService(repository, new ObjectMapper(), null, publisher);
        UserContext.set(1L, "owner");
        when(repository.find(5L)).thenReturn(Optional.of(row));
        assertThrows(BizException.class, () -> withEvents.rename(5, ""));
        assertThrows(BizException.class, () -> withEvents.rename(5, "新标题"));
        verifyNoInteractions(publisher);
        when(repository.rename(5L, "新标题")).thenReturn(true);
        withEvents.rename(5, "新标题");
        verify(publisher).publishEvent(new DocumentService.DocumentRenamed(5));
    }

    @Test
    void ownerReadsContentAndRevisionFromSameRow() {
        UserContext.set(1L, "owner");
        when(repository.find(5L)).thenReturn(Optional.of(row));

        DocumentService.DetailView detail = service.detail(5L);

        assertEquals(8L, detail.revision());
        assertEquals("正文\n", detail.content().get("ops").get(0).get("insert").asText());
        assertEquals(2, detail.permission());
        assertEquals("2026-09-26 15:00:00", detail.updateTime());
    }

    @Test
    void templateCreationStoresMatchingRevisionZeroSnapshot() throws Exception {
        UserContext.set(1L, "owner");
        when(repository.create(anyString(), eq(1L), eq(0L), anyString())).thenReturn(5L);
        when(repository.find(5L)).thenReturn(Optional.of(row));
        service.create(null, 0L, "meeting");
        var content = org.mockito.ArgumentCaptor.forClass(String.class);
        verify(repository).create(eq("会议纪要"), eq(1L), eq(0L), content.capture());
        verify(repository).saveInitialSnapshot(5L, content.getValue());
        var delta = new ObjectMapper().readTree(content.getValue());
        assertEquals("会议纪要", delta.get("ops").get(0).get("insert").asText());
        assertEquals(1, delta.get("ops").get(1).get("attributes").get("header").asInt());
    }

    @Test
    void invalidTemplateAndMissingLoginNeverCreateDocument() {
        UserContext.set(1L, "owner");
        assertEquals(ErrorCode.PARAM_ERROR, assertThrows(BizException.class,
            () -> service.create("test", 0, "unknown")).getErrorCode());
        UserContext.clear();
        assertEquals(ErrorCode.UNAUTHORIZED, assertThrows(BizException.class,
            () -> service.create("test", 0, "meeting")).getErrorCode());
        verify(repository, never()).create(anyString(), anyLong(), anyLong(), anyString());
    }

    @Test
    void importedBodyAndBaselineUseSameContentWithoutCopyingPermissions() throws Exception {
        UserContext.set(1L, "owner");
        when(repository.create(anyString(), eq(1L), eq(0L), anyString())).thenReturn(5L);
        when(repository.find(5L)).thenReturn(Optional.of(row));
        service.createImported(" 导入正文 ", new ObjectMapper().readTree(row.content()));
        verify(repository).create("导入正文", 1L, 0L, row.content());
        verify(repository).saveInitialSnapshot(5L, row.content());
        verify(repository, never()).addCollaborator(anyLong(), anyLong(), anyInt());
    }

    @Test
    void blankDocumentCreationStillUsesEmptyDelta() {
        UserContext.set(1L, "owner");
        when(repository.create(anyString(), eq(1L), eq(0L), anyString())).thenReturn(5L);
        when(repository.find(5L)).thenReturn(Optional.of(row));
        service.create(null, 0);
        verify(repository).create("未命名文档", 1L, 0L, "{\"ops\":[{\"insert\":\"\\n\"}]}");
        verify(repository, never()).saveInitialSnapshot(anyLong(), anyString());
    }

    @Test
    void readOnlyCollaboratorCanReadButCannotRenameOrDelete() {
        UserContext.set(2L, "reader");
        when(repository.find(5L)).thenReturn(Optional.of(row));
        when(repository.collaboratorPermission(5L, 2L)).thenReturn(1);

        assertEquals(1, service.detail(5L).permission());
        assertEquals(ErrorCode.FORBIDDEN,
                assertThrows(BizException.class, () -> service.rename(5L, "新标题")).getErrorCode());
        assertEquals(ErrorCode.FORBIDDEN,
                assertThrows(BizException.class, () -> service.delete(5L)).getErrorCode());
        verify(repository, never()).rename(anyLong(), anyString());
        verify(repository, never()).softDelete(anyLong());
    }

    @Test
    void editorCanRenameButOnlyOwnerCanDelete() {
        UserContext.set(2L, "editor");
        DocumentRow renamed = new DocumentRow(
                5L, "新标题", row.content(), row.revision(), row.ownerId(),
                row.ownerName(), row.parentId(), row.updateTime());
        when(repository.find(5L)).thenReturn(Optional.of(row), Optional.of(renamed));
        when(repository.collaboratorPermission(5L, 2L)).thenReturn(2);
        when(repository.rename(5L, "新标题")).thenReturn(true);

        assertEquals("新标题", service.rename(5L, "新标题").title());
        assertEquals(ErrorCode.FORBIDDEN,
                assertThrows(BizException.class, () -> service.delete(5L)).getErrorCode());
    }

    @Test
    void unrelatedUserIsDeniedAndDeletedDocumentIsNotFound() {
        UserContext.set(3L, "stranger");
        when(repository.find(5L)).thenReturn(Optional.of(row));
        assertEquals(ErrorCode.FORBIDDEN,
                assertThrows(BizException.class, () -> service.detail(5L)).getErrorCode());

        when(repository.find(5L)).thenReturn(Optional.empty());
        assertEquals(ErrorCode.NOT_FOUND,
                assertThrows(BizException.class, () -> service.detail(5L)).getErrorCode());
    }

    @Test
    void restoreRequiresOwnershipAndPreservesExistingContentAndRevision() {
        UserContext.set(1L,"owner");
        when(repository.findOwnedForUpdate(5L,1L)).thenReturn(Optional.of(new DocumentRepository.OwnedState(row,true)));
        when(repository.restoreDeleted(5L,1L)).thenReturn(true);
        when(repository.find(5L)).thenReturn(Optional.of(row));
        assertEquals(5L,service.restoreDeleted(5L).id());
        verify(repository).restoreDeleted(5L,1L);
        verify(repository,never()).create(anyString(),anyLong(),anyLong(),anyString());
        UserContext.set(2L,"member");
        assertEquals(ErrorCode.NOT_FOUND,assertThrows(BizException.class,()->service.restoreDeleted(5L)).getErrorCode());
        verify(repository,never()).restoreDeleted(5L,2L);
    }

    @Test
    void repeatedRestoreOfActiveOwnedDocumentDoesNotMutateIt() {
        UserContext.set(1L,"owner");
        when(repository.findOwnedForUpdate(5L,1L)).thenReturn(Optional.of(new DocumentRepository.OwnedState(row,false)));
        when(repository.find(5L)).thenReturn(Optional.of(row));
        assertEquals(5L,service.restoreDeleted(5L).id());
        verify(repository,never()).restoreDeleted(anyLong(),anyLong());
        assertEquals(8L,service.detail(5L).revision());
    }

    @Test
    void trashUsesOnlyCurrentOwnerAndDoesNotExposeBody() {
        UserContext.set(2L,"member");
        when(repository.countDeletedOwned(2L)).thenReturn(1L);
        when(repository.listDeletedOwned(2L,1,20)).thenReturn(java.util.List.of(new DocumentRepository.TrashRow(5,"标题",row.updateTime())));
        var trash=service.trash(1,20);
        assertEquals(1L,trash.total());
        assertEquals("标题",trash.list().getFirst().title());
        assertEquals("2026-09-26 15:00:00",trash.list().getFirst().deletedAt());
        assertFalse(trash.toString().contains("正文"));
        verify(repository,never()).listDeletedOwned(eq(1L),anyInt(),anyInt());
        assertThrows(BizException.class,()->service.trash(0,20));
    }
}
