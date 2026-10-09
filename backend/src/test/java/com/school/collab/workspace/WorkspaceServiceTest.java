package com.school.collab.workspace;

import com.school.collab.common.BizException;
import com.school.collab.common.ErrorCode;
import com.school.collab.common.UserContext;
import com.school.collab.group.GroupRepository;
import com.school.collab.project.ProjectRepository;
import com.school.collab.template.PersonalTemplateRepository;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataAccessResourceFailureException;
import java.util.List;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class WorkspaceServiceTest {
    private final GroupRepository groups = mock(GroupRepository.class);
    private final ProjectRepository projects = mock(ProjectRepository.class);
    private final PersonalTemplateRepository templates = mock(PersonalTemplateRepository.class);
    private final WorkspaceService service = new WorkspaceService(groups, projects, templates);
    @AfterEach void clear() { UserContext.clear(); }

    @Test void anonymousCannotInspectOrganizationOrPrivateTemplateCounts() {
        assertEquals(ErrorCode.UNAUTHORIZED, assertThrows(BizException.class, service::overview).getErrorCode());
        verifyNoInteractions(groups, projects, templates);
    }

    @Test void overviewUsesTrustedIdentityAndNeverLoadsDocumentOrTemplateBodies() {
        UserContext.set(7L, "current");
        when(groups.count(7, false)).thenReturn(2L);
        when(projects.count(7, "personal", 0, false, "")).thenReturn(3L);
        when(projects.count(7, "group", 0, false, "")).thenReturn(4L);
        when(templates.count(7, "all", "")).thenReturn(5L);
        when(groups.inboxCount(7)).thenReturn(8L);
        var invitation = new GroupRepository.Invitation(11, "邀请小组", "简介", "peer", "同伴", "2026-10-09 09:00:00", 2);
        when(groups.inbox(7, 1, 3)).thenReturn(List.of(invitation));
        var result = service.overview();
        assertEquals(new WorkspaceService.Overview(2, 3, 4, 5, 8, List.of(invitation)), result);
        verify(groups).count(7, false);
        verify(projects).count(7, "personal", 0, false, "");
        verify(projects).count(7, "group", 0, false, "");
        verify(templates).count(7, "all", "");
        verify(groups).inboxCount(7);
        verify(groups).inbox(7, 1, 3);
        verifyNoMoreInteractions(groups, projects, templates);
    }

    @Test void unavailableDatabaseDoesNotPretendTheWorkspaceIsEmpty() {
        UserContext.set(7L, "current");
        var failure = new DataAccessResourceFailureException("unavailable");
        when(groups.count(7, false)).thenThrow(failure);
        assertSame(failure, assertThrows(DataAccessResourceFailureException.class, service::overview));
        verifyNoInteractions(projects, templates);
    }
}
