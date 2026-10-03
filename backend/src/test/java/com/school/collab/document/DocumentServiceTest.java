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
}
