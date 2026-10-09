package com.school.collab.project;

import com.school.collab.common.Result;
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/api/projects")
public class ProjectController {
    private final ProjectService projects;
    public ProjectController(ProjectService projects) {this.projects=projects;}
    @GetMapping public Result<ProjectService.ListView> list(@RequestParam(defaultValue="all")String scope,@RequestParam(defaultValue="0")long groupId,
        @RequestParam(defaultValue="false")boolean archived,@RequestParam(defaultValue="")String keyword,
        @RequestParam(defaultValue="1")int page,@RequestParam(defaultValue="20")int size) {return Result.ok(projects.list(scope,groupId,archived,keyword,page,size));}
    @PostMapping public Result<ProjectService.IdView> create(@RequestBody Create body) {return Result.ok(projects.create(body.name(),body.description(),body.groupId()==null?0:body.groupId()));}
    @GetMapping("/{id}") public Result<ProjectService.Detail> detail(@PathVariable long id,@RequestParam(defaultValue="")String keyword,@RequestParam(defaultValue="1")int page,@RequestParam(defaultValue="20")int size) {return Result.ok(projects.detail(id,keyword,page,size));}
    @GetMapping("/{id}/candidates") public Result<ProjectService.Candidates> candidates(@PathVariable long id,@RequestParam(defaultValue="")String keyword,@RequestParam(defaultValue="1")int page,@RequestParam(defaultValue="20")int size) {return Result.ok(projects.candidates(id,keyword,page,size));}
    @PutMapping("/{id}") public Result<Void> rename(@PathVariable long id,@RequestBody Fields body) {projects.rename(id,body.name(),body.description());return Result.ok();}
    @PostMapping("/{id}/archive") public Result<Void> archive(@PathVariable long id) {projects.archive(id,true);return Result.ok();}
    @PostMapping("/{id}/restore") public Result<Void> restore(@PathVariable long id) {projects.archive(id,false);return Result.ok();}
    @PostMapping("/{id}/documents") public Result<ProjectService.Change> add(@PathVariable long id,@RequestBody Add body) {return Result.ok(projects.add(id,body.docId()==null?0:body.docId()));}
    @DeleteMapping("/{id}/documents/{docId}") public Result<ProjectService.Change> remove(@PathVariable long id,@PathVariable long docId,@RequestParam String associationId) {return Result.ok(projects.remove(id,docId,associationId));}
    public record Create(String name,String description,Long groupId) { }
    public record Fields(String name,String description) { }
    public record Add(Long docId) { }
}
