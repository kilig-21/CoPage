package com.school.collab.document;

import com.school.collab.common.Result;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

@RestController
@RequestMapping("/api/doc")
public class DocumentTransferController {
    private final DocumentTransfer transfer;
    private final DocumentCreationRequests creations;
    public DocumentTransferController(DocumentTransfer transfer, DocumentCreationRequests creations) { this.transfer = transfer; this.creations=creations; }

    @PostMapping(value="/import", consumes="multipart/form-data")
    public Result<DocumentService.SummaryView> importFile(@RequestParam MultipartFile file,
            @RequestParam(required=false) String title, @RequestHeader(value="Idempotency-Key", required=false) String key) {
        return Result.ok(creations.execute(key, "import", key == null ? null : creations.importInput(file, title),
                DocumentService.SummaryView.class, () -> transfer.importFile(file, title)));
    }

    @GetMapping("/{id}/export")
    public Result<DocumentTransfer.ExportView> export(@PathVariable long id,
            @RequestParam(defaultValue="copage") String format) { return Result.ok(transfer.export(id, format)); }
}
