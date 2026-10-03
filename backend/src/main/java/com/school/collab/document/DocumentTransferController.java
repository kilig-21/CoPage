package com.school.collab.document;

import com.school.collab.common.Result;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

@RestController
@RequestMapping("/api/doc")
public class DocumentTransferController {
    private final DocumentTransfer transfer;
    public DocumentTransferController(DocumentTransfer transfer) { this.transfer = transfer; }

    @PostMapping(value="/import", consumes="multipart/form-data")
    public Result<DocumentService.SummaryView> importFile(@RequestParam MultipartFile file,
            @RequestParam(required=false) String title) { return Result.ok(transfer.importFile(file, title)); }

    @GetMapping("/{id}/export")
    public Result<DocumentTransfer.ExportView> export(@PathVariable long id,
            @RequestParam(defaultValue="copage") String format) { return Result.ok(transfer.export(id, format)); }
}
