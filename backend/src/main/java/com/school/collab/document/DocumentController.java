package com.school.collab.document;

import com.school.collab.common.Result;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/doc")
public class DocumentController {
    private final DocumentService documents;
    private final DocumentCreationRequests creations;

    public DocumentController(DocumentService documents, DocumentCreationRequests creations) {
        this.documents = documents; this.creations = creations;
    }

    @GetMapping("/list")
    public Result<DocumentService.ListView> list(
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int size,
            @RequestParam(defaultValue = "") String keyword,
            @RequestParam(defaultValue = "all") String scope
    ) {
        return Result.ok(documents.list(page, size, keyword, scope));
    }

    @GetMapping("/workbench")
    public Result<DocumentService.WorkbenchView> workbench() {
        return Result.ok(documents.workbench());
    }

    @PostMapping
    public Result<DocumentService.SummaryView> create(@RequestBody(required = false) CreateRequest request,
            @RequestHeader(value="Idempotency-Key", required=false) String key) {
        var input = new CreateRequest(request == null ? null : request.title(),
                request == null || request.parentId() == null ? 0 : request.parentId(),
                request == null ? null : request.templateId());
        return Result.ok(creations.execute(key, "document", input, DocumentService.SummaryView.class,
                () -> documents.create(input.title(), input.parentId(), input.templateId())));
    }

    @GetMapping("/trash")
    public Result<DocumentService.TrashView> trash(@RequestParam(defaultValue="1") int page,
                                                   @RequestParam(defaultValue="20") int size) {
        return Result.ok(documents.trash(page,size));
    }

    @PostMapping("/{id}/restore")
    public Result<DocumentService.SummaryView> restoreDeleted(@PathVariable long id) {
        return Result.ok(documents.restoreDeleted(id));
    }

    @GetMapping("/templates")
    public Result<java.util.List<DocumentTemplates.TemplateView>> templates() {
        if (com.school.collab.common.UserContext.getUserId() == null) {
            throw new com.school.collab.common.BizException(com.school.collab.common.ErrorCode.UNAUTHORIZED);
        }
        return Result.ok(DocumentTemplates.list());
    }

    @PostMapping("/{id}/copy")
    public Result<DocumentService.CopyView> copy(@PathVariable long id,
            @RequestBody(required = false) CopyRequest request,
            @RequestHeader(value="Idempotency-Key", required=false) String key) {
        var input = new CopyRequest(request == null ? null : request.title());
        return Result.ok(creations.execute(key, "copy:" + id, input, DocumentService.CopyView.class,
                () -> documents.copy(id, input.title())));
    }

    public record CopyRequest(String title) { }

    @GetMapping("/{id}")
    public Result<DocumentService.DetailView> detail(@PathVariable long id) {
        return Result.ok(documents.detail(id));
    }

    @GetMapping("/{id}/metadata")
    public Result<DocumentService.RenameView> metadata(@PathVariable long id) {
        return Result.ok(documents.metadata(id));
    }

    @PutMapping("/{id}")
    public Result<DocumentService.RenameView> rename(
            @PathVariable long id, @Valid @RequestBody RenameRequest request
    ) {
        return Result.ok(documents.rename(id, request.title()));
    }

    @DeleteMapping("/{id}")
    public Result<Void> delete(@PathVariable long id) {
        documents.delete(id);
        return Result.ok();
    }

    public record CreateRequest(String title, Long parentId, String templateId) {
    }

    public record RenameRequest(@NotBlank @Size(max = 200) String title) {
    }
}
