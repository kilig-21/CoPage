package com.school.collab.workspace;

import com.school.collab.common.Result;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/workspace")
public class WorkspaceController {
    private final WorkspaceService workspace;
    public WorkspaceController(WorkspaceService workspace) { this.workspace = workspace; }

    @GetMapping("/overview")
    public Result<WorkspaceService.Overview> overview() {
        return Result.ok(workspace.overview());
    }
}
