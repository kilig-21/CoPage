package com.school.collab.template;

import com.school.collab.common.Result;
import com.school.collab.document.DocumentService;
import com.school.collab.document.DocumentCreationRequests;
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/api/personal-templates")
public class PersonalTemplateController {
    private final PersonalTemplateService templates;
    private final DocumentCreationRequests creations;
    public PersonalTemplateController(PersonalTemplateService templates, DocumentCreationRequests creations) {this.templates=templates;this.creations=creations;}
    @GetMapping public Result<PersonalTemplateService.ListView> list(@RequestParam(defaultValue="all")String category,@RequestParam(defaultValue="")String keyword,
        @RequestParam(defaultValue="1")int page,@RequestParam(defaultValue="20")int size) {return Result.ok(templates.list(category,keyword,page,size));}
    @PostMapping public Result<PersonalTemplateService.Created> create(@RequestBody Create body) {return Result.ok(templates.create(body.docId()==null?0:body.docId(),body.name(),body.description(),body.category()));}
    @GetMapping("/{id}") public Result<PersonalTemplateService.Detail> detail(@PathVariable long id) {return Result.ok(templates.detail(id));}
    @PutMapping("/{id}") public Result<Void> update(@PathVariable long id,@RequestBody Fields body) {
        templates.update(id,body.name(),body.description(),body.category(),body.expectedVersion()==null?0:body.expectedVersion());return Result.ok();}
    @DeleteMapping("/{id}") public Result<Void> delete(@PathVariable long id,@RequestParam long expectedVersion) {templates.delete(id,expectedVersion);return Result.ok();}
    @PostMapping("/{id}/documents") public Result<DocumentService.SummaryView> instantiate(@PathVariable long id,@RequestBody Instance body,
            @RequestHeader(value="Idempotency-Key", required=false) String key) {
        var input=new Instance(body.title(),body.expectedVersion()==null?0:body.expectedVersion());
        return Result.ok(creations.execute(key,"personal-template:"+id,input,DocumentService.SummaryView.class,
                ()->templates.instantiate(id,input.title(),input.expectedVersion())));}
    public record Create(Long docId,String name,String description,String category) { }
    public record Fields(String name,String description,String category,Long expectedVersion) { }
    public record Instance(String title,Long expectedVersion) { }
}
