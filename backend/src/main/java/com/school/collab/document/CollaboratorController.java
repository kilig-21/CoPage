package com.school.collab.document;

import com.school.collab.common.Result;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api/doc/{docId}/collaborators")
public class CollaboratorController {
    private final CollaboratorService collaborators;

    public CollaboratorController(CollaboratorService collaborators) { this.collaborators = collaborators; }

    @GetMapping
    public Result<List<DocumentRepository.CollaboratorView>> list(@PathVariable long docId) {
        return Result.ok(collaborators.list(docId));
    }

    @PostMapping
    public Result<Void> invite(@PathVariable long docId, @Valid @RequestBody InviteRequest request) {
        collaborators.invite(docId, request.username(), request.permission());
        return Result.ok();
    }

    @PutMapping("/{userId}")
    public Result<Void> change(@PathVariable long docId, @PathVariable long userId,
                             @Valid @RequestBody PermissionRequest request) {
        collaborators.change(docId, userId, request.permission());
        return Result.ok();
    }

    @DeleteMapping("/{userId}")
    public Result<Void> remove(@PathVariable long docId, @PathVariable long userId) {
        collaborators.remove(docId, userId);
        return Result.ok();
    }

    public record InviteRequest(@NotBlank @Size(max = 50) String username,
                                @NotNull @Min(1) @Max(2) Integer permission) { }
    public record PermissionRequest(@NotNull @Min(1) @Max(2) Integer permission) { }
}
