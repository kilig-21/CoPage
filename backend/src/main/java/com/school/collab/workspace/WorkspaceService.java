package com.school.collab.workspace;

import com.school.collab.common.BizException;
import com.school.collab.common.ErrorCode;
import com.school.collab.common.UserContext;
import com.school.collab.group.GroupRepository;
import com.school.collab.project.ProjectRepository;
import com.school.collab.template.PersonalTemplateRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import java.util.List;

@Service
public class WorkspaceService {
    private final GroupRepository groups;
    private final ProjectRepository projects;
    private final PersonalTemplateRepository templates;

    public WorkspaceService(GroupRepository groups, ProjectRepository projects, PersonalTemplateRepository templates) {
        this.groups = groups;
        this.projects = projects;
        this.templates = templates;
    }

    @Transactional(readOnly = true)
    public Overview overview() {
        Long user = UserContext.getUserId();
        if (user == null) throw new BizException(ErrorCode.UNAUTHORIZED);
        long activeGroups = groups.count(user, false);
        long personalProjects = projects.count(user, "personal", 0, false, "");
        long groupProjects = projects.count(user, "group", 0, false, "");
        long personalTemplates = templates.count(user, "all", "");
        long invitations = groups.inboxCount(user);
        return new Overview(activeGroups, personalProjects, groupProjects, personalTemplates, invitations,
                invitations == 0 ? List.of() : groups.inbox(user, 1, 3));
    }

    public record Overview(long activeGroupCount, long personalProjectCount, long groupProjectCount,
                           long personalTemplateCount, long pendingInvitationCount,
                           List<GroupRepository.Invitation> invitations) { }
}
