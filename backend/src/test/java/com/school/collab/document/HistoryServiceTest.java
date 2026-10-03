package com.school.collab.document;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.collab.service.DocRevService;
import com.school.collab.collab.ws.CollabEventBus;
import com.school.collab.common.BizException;
import com.school.collab.common.UserContext;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import java.time.LocalDateTime;
import java.util.Optional;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class HistoryServiceTest {
    @AfterEach void clear() { UserContext.clear(); }
    @Test void readableCollaboratorCannotRestoreOrName() {
        var history = mock(HistoryRepository.class);
        var documents = mock(DocumentRepository.class);
        var permissions = mock(DocumentService.class);
        var revisions = mock(DocRevService.class);
        when(permissions.permissionFor(1, 2)).thenReturn(2);
        when(documents.find(1)).thenReturn(Optional.of(new DocumentRepository.DocumentRow(1, "文档", "{}", 3, 1, "所有者", 0, LocalDateTime.now())));
        var service = new HistoryService(history, documents, permissions, revisions, mock(CollabEventBus.class), new ObjectMapper(),mock(HistoryMaintenance.class));
        UserContext.set(2L, "member");
        assertThrows(BizException.class, () -> service.restore(1, 1, 3, "request"));
        assertThrows(BizException.class, () -> service.name(1, 1, "重要"));
        assertThrows(BizException.class, () -> service.unname(1, 1));
        assertThrows(BizException.class, () -> service.compact(1, 3, 2));
        verifyNoInteractions(revisions, history);
    }
}
