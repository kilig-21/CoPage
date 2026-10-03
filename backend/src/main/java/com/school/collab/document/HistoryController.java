package com.school.collab.document;

import com.school.collab.common.Result;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.PositiveOrZero;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/doc/{id}/history")
public class HistoryController {
    private final HistoryService history;
    public HistoryController(HistoryService history) { this.history = history; }

    @GetMapping
    public Result<HistoryService.HistoryView> list(@PathVariable long id,
            @RequestParam(defaultValue="9223372036854775807") long beforeRevision,
            @RequestParam(defaultValue="20") int limit) {
        return Result.ok(history.list(id, beforeRevision, limit));
    }
    @GetMapping("/{revision}")
    public Result<HistoryService.ContentView> content(@PathVariable long id, @PathVariable long revision) {
        return Result.ok(history.content(id, revision));
    }
    @PutMapping("/{revision}/name")
    public Result<Void> name(@PathVariable long id, @PathVariable long revision, @Valid @RequestBody NameBody body) {
        history.name(id, revision, body.name()); return Result.ok(null);
    }
    @DeleteMapping("/{revision}/name")
    public Result<Void> unname(@PathVariable long id, @PathVariable long revision) {
        history.unname(id, revision); return Result.ok(null);
    }
    @PostMapping("/{revision}/restore")
    public Result<HistoryService.RestoreView> restore(@PathVariable long id, @PathVariable long revision,
                                                     @Valid @RequestBody RestoreBody body) {
        return Result.ok(history.restore(id, revision, body.expectedRevision(), body.requestId()));
    }
    public record NameBody(@NotBlank @Size(max=100) String name) { }
    public record RestoreBody(@NotNull @PositiveOrZero Long expectedRevision, @NotBlank @Size(max=128) String requestId) { }
}
