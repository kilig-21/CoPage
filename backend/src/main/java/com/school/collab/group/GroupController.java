package com.school.collab.group;

import com.school.collab.common.Result;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/groups")
public class GroupController {
    private final GroupService groups;
    public GroupController(GroupService groups) { this.groups=groups; }
    @GetMapping
    public Result<GroupService.ListView> list(@RequestParam(defaultValue="false")boolean archived,@RequestParam(defaultValue="1")int page,@RequestParam(defaultValue="20")int size) { return Result.ok(groups.list(archived,page,size)); }
    @PostMapping
    public Result<GroupService.IdView> create(@RequestBody Fields body) { return Result.ok(groups.create(body.name(),body.description())); }
    @GetMapping("/invitations")
    public Result<GroupService.Inbox> inbox(@RequestParam(defaultValue="1")int page,@RequestParam(defaultValue="20")int size) { return Result.ok(groups.inbox(page,size)); }
    @GetMapping("/{id}")
    public Result<GroupService.Detail> detail(@PathVariable long id) { return Result.ok(groups.detail(id)); }
    @PutMapping("/{id}")
    public Result<Void> rename(@PathVariable long id,@RequestBody Fields body) { groups.rename(id,body.name(),body.description());return Result.ok(); }
    @PostMapping("/{id}/invitations")
    public Result<Void> invite(@PathVariable long id,@RequestBody Invite body) { groups.invite(id,body.username());return Result.ok(); }
    @PostMapping("/{id}/invitation")
    public Result<Void> respond(@PathVariable long id,@Valid @RequestBody Response body) { groups.respond(id,body.accept(),body.invitationVersion());return Result.ok(); }
    @DeleteMapping("/{id}/invitations/{userId}")
    public Result<Void> cancel(@PathVariable long id,@PathVariable long userId,@RequestParam long invitationVersion) { groups.cancelInvitation(id,userId,invitationVersion);return Result.ok(); }
    @PutMapping("/{id}/members/{userId}")
    public Result<Void> role(@PathVariable long id,@PathVariable long userId,@RequestBody Role body) { groups.changeRole(id,userId,body.role());return Result.ok(); }
    @DeleteMapping("/{id}/members/{userId}")
    public Result<Void> remove(@PathVariable long id,@PathVariable long userId) { groups.remove(id,userId);return Result.ok(); }
    @PostMapping("/{id}/leave")
    public Result<Void> leave(@PathVariable long id) { groups.leave(id);return Result.ok(); }
    @PostMapping("/{id}/archive")
    public Result<Void> archive(@PathVariable long id) { groups.archive(id,true);return Result.ok(); }
    @PostMapping("/{id}/restore")
    public Result<Void> restore(@PathVariable long id) { groups.archive(id,false);return Result.ok(); }
    public record Fields(String name,String description) { }
    public record Invite(String username) { }
    public record Role(String role) { }
    public record Response(@NotNull Boolean accept,@NotNull @jakarta.validation.constraints.Min(1) Long invitationVersion) { }
}
