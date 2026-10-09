package com.school.collab.group;

import com.school.collab.common.BizException;
import com.school.collab.common.ErrorCode;
import com.school.collab.common.UserContext;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import java.util.List;

@Service
public class GroupService {
    private static final int CAPACITY=200;
    private final GroupRepository groups;
    public GroupService(GroupRepository groups) { this.groups=groups; }
    @Transactional(readOnly=true)
    public ListView list(boolean archived,int page,int size) {
        long user=user(); paging(page,size);
        return new ListView(groups.count(user,archived),groups.list(user,archived,page,size));
    }
    @Transactional
    public IdView create(String name,String description) {
        long user=user(); String normalized=name(name), about=description(description);
        long id=groups.create(normalized,about,user); groups.add(id,user,"owner"); return new IdView(id);
    }
    @Transactional(readOnly=true)
    public Detail detail(long id) {
        var g=active(id,false); String role=membership(g);
        return new Detail(g.id(),g.name(),g.description(),g.ownerId(),user(),role,groups.members(id),
                manager(role)?groups.pending(id):List.of());
    }
    @Transactional
    public void rename(long id,String name,String description) {
        var g=active(id,true); requireManager(membership(g));
        groups.rename(id,name(name),description(description));
    }
    @Transactional
    public void invite(long id,String username) {
        var g=active(id,true); requireManager(membership(g));
        String name=username==null?"":username.trim();
        if(name.length()<3||name.length()>50)throw bad("请输入3～50字符的已注册用户名");
        var target=groups.account(name).orElseThrow(()->new BizException(ErrorCode.NOT_FOUND,"该用户名尚未注册"));
        if(target.id()==g.ownerId()||groups.role(id,target.id())!=null)throw bad("该用户已是小组成员");
        if("pending".equals(groups.invitation(id,target.id())))return;
        if(groups.memberCount(id)+groups.pendingCount(id)>=CAPACITY)throw bad("小组成员与待接受邀请合计最多200人");
        groups.invite(id,target.id(),user()); groups.touch(id);
    }
    @Transactional(readOnly=true)
    public Inbox inbox(int page,int size) {
        long user=user();paging(page,size);return new Inbox(groups.inboxCount(user),groups.inbox(user,page,size));
    }
    @Transactional
    public void respond(long id,boolean accept,long invitationVersion) {
        long user=user(); active(id,true);
        requireInvitationVersion(id,user,invitationVersion);
        String status=groups.invitation(id,user);
        if(accept&&"accepted".equals(status)&&groups.role(id,user)!=null)return;
        if(!accept&&"declined".equals(status))return;
        if(!"pending".equals(status))throw new BizException(ErrorCode.NOT_FOUND,"邀请已结束，请联系管理员重新邀请");
        if(accept) {
            if(groups.role(id,user)==null) {
                if(groups.memberCount(id)>=CAPACITY)throw bad("小组成员已达200人");
                groups.add(id,user,"member");
            }
            groups.invitationStatus(id,user,"accepted");
        } else groups.invitationStatus(id,user,"declined");
        groups.touch(id);
    }
    @Transactional
    public void cancelInvitation(long id,long target,long invitationVersion) {
        var g=active(id,true); requireManager(membership(g));
        requireInvitationVersion(id,target,invitationVersion);
        if(target<=0||!"pending".equals(groups.invitation(id,target)))throw new BizException(ErrorCode.NOT_FOUND,"该邀请已结束");
        groups.invitationStatus(id,target,"cancelled");groups.touch(id);
    }
    @Transactional
    public void changeRole(long id,long target,String role) {
        var g=active(id,true); requireOwner(g);
        if(role==null||!List.of("admin","member").contains(role))throw bad("成员角色只能为管理员或成员");
        protectedTarget(g,target);
        if(groups.role(id,target)==null)throw new BizException(ErrorCode.NOT_FOUND,"该用户不是小组成员");
        groups.role(id,target,role);groups.touch(id);
    }
    @Transactional
    public void remove(long id,long target) {
        var g=active(id,true); String actor=membership(g); requireManager(actor); protectedTarget(g,target);
        if(target==user())throw bad("请使用退出小组");
        String targetRole=groups.role(id,target);
        if(targetRole==null)throw new BizException(ErrorCode.NOT_FOUND,"该用户不是小组成员");
        if(!"owner".equals(actor)&&!"member".equals(targetRole))throw new BizException(ErrorCode.FORBIDDEN,"只有创建者可以移除管理员");
        groups.remove(id,target);groups.touch(id);
    }
    @Transactional
    public void leave(long id) {
        var g=active(id,true); membership(g);
        if(g.ownerId()==user())throw bad("创建者不能退出，请按需要归档小组");
        groups.remove(id,user());groups.touch(id);
    }
    @Transactional
    public void archive(long id,boolean archived) {
        var g=existing(id,true);requireOwner(g);groups.archive(id,archived);groups.touch(id);
    }
    private void requireInvitationVersion(long group,long target,long expected) {
        if(expected<=0||groups.invitationVersion(group,target)!=expected)throw bad("邀请已更新或失效，请刷新当前邀请");
    }
    /** Caller holds its read/write transaction; lock the group before project rows on writes. */
    public Access access(long id,boolean lock) {
        var g=active(id,lock);
        // Project writes may already have a repeatable-read snapshot before waiting for this lock.
        String role=lock?groups.roleForUpdate(g.id(),user()):groups.role(g.id(),user());
        if(role==null)throw new BizException(ErrorCode.FORBIDDEN,"你不是此小组的成员");
        return new Access(g.id(),g.name(),g.ownerId()==user()?"owner":role);
    }
    public record Access(long id,String name,String role) {
        public boolean canManage() { return "owner".equals(role)||"admin".equals(role); }
    }
    private GroupRepository.Group active(long id,boolean lock) {
        var g=existing(id,lock);if(g.archived())throw new BizException(ErrorCode.NOT_FOUND,"小组已归档");return g;
    }
    private GroupRepository.Group existing(long id,boolean lock) {
        user();if(id<=0)throw bad("小组编号无效");
        return groups.find(id,lock).orElseThrow(()->new BizException(ErrorCode.NOT_FOUND));
    }
    private String membership(GroupRepository.Group g) {
        String role=groups.role(g.id(),user());
        if(role==null)throw new BizException(ErrorCode.FORBIDDEN,"你不是此小组的成员");
        return g.ownerId()==user()?"owner":role;
    }
    private void requireOwner(GroupRepository.Group g) { if(g.ownerId()!=user())throw new BizException(ErrorCode.FORBIDDEN,"只有创建者可以执行此操作"); }
    private void protectedTarget(GroupRepository.Group g,long target) { if(target<=0||target==g.ownerId())throw bad("不能修改小组创建者"); }
    private static boolean manager(String role) { return "owner".equals(role)||"admin".equals(role); }
    private static void requireManager(String role) { if(!manager(role))throw new BizException(ErrorCode.FORBIDDEN,"需要小组管理权限"); }
    private static long user() { Long id=UserContext.getUserId();if(id==null||id<=0)throw new BizException(ErrorCode.UNAUTHORIZED);return id; }
    private static void paging(int page,int size) { if(page<1||page>1000000||size<1||size>100)throw bad("分页参数无效"); }
    private static String name(String input) { String s=input==null?"":input.trim();if(s.isEmpty()||s.length()>80||s.chars().anyMatch(Character::isISOControl))throw bad("小组名称需要1～80个字符且无控制字符");return s; }
    private static String description(String input) { String s=input==null?"":input.trim();if(s.length()>300||s.chars().anyMatch(c->Character.isISOControl(c)&&c!='\n'&&c!='\r'))throw bad("小组简介最多300个字符");return s; }
    private static BizException bad(String message) { return new BizException(ErrorCode.PARAM_ERROR,message); }
    public record IdView(long id) { }
    public record ListView(long total,List<GroupRepository.Summary> list) { }
    public record Inbox(long total,List<GroupRepository.Invitation> list) { }
    public record Detail(long id,String name,String description,long ownerId,long currentUserId,String role,List<GroupRepository.Member> members,List<GroupRepository.Pending> invitations) { }
}
