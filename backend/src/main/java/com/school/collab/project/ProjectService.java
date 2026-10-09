package com.school.collab.project;

import com.school.collab.common.BizException;
import com.school.collab.common.ErrorCode;
import com.school.collab.common.UserContext;
import com.school.collab.group.GroupService;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import java.util.List;
import java.util.UUID;

@Service
public class ProjectService {
    private final ProjectRepository projects;
    private final GroupService groups;
    public ProjectService(ProjectRepository projects,GroupService groups) { this.projects=projects;this.groups=groups; }
    @Transactional(readOnly=true)
    public ListView list(String scope,long group,boolean archived,String keyword,int page,int size) {
        long user=user();paging(page,size);
        if(scope==null||!List.of("all","personal","group").contains(scope)||group<0)throw bad("项目分类无效");
        if(group>0)groups.access(group,false);
        String filter=filter(keyword);
        return new ListView(projects.count(user,scope,group,archived,filter),projects.list(user,scope,group,archived,filter,page,size));
    }
    @Transactional
    public IdView create(String name,String description,long group) {
        long user=user();String normalized=name(name),about=description(description);
        if(group<0)throw bad("小组编号无效");
        if(group>0&&!groups.access(group,true).canManage())throw new BizException(ErrorCode.FORBIDDEN,"创建小组项目需要管理权限");
        return new IdView(projects.create(normalized,about,user,group),group);
    }
    @Transactional(readOnly=true)
    public Detail detail(long id,String keyword,int page,int size) {
        user();paging(page,size);var access=access(id,false,false);var p=access.project();String filter=filter(keyword);
        return new Detail(p.id(),p.name(),p.description(),p.ownerId(),p.groupId(),access.groupName(),access.canManage(),
            projects.documentCount(id,user(),filter),projects.documents(id,user(),access.canManage(),filter,page,size));
    }
    @Transactional(readOnly=true)
    public Candidates candidates(long id,String keyword,int page,int size) {
        user();paging(page,size);var p=access(id,false,false).project();String filter=filter(keyword);
        return new Candidates(projects.candidateCount(id,user(),p.groupId()>0,filter),
            projects.candidates(id,user(),p.groupId()>0,filter,page,size));
    }
    @Transactional
    public void rename(long id,String name,String description) {
        var access=access(id,true,false);manage(access);projects.rename(id,name(name),description(description));
    }
    @Transactional
    public void archive(long id,boolean archived) {
        var access=access(id,true,true);manage(access);projects.archive(id,archived);
    }
    @Transactional
    public Change add(long id,long docId) {
        long user=user();var access=access(id,true,false);var d=document(docId,user);
        if(access.project().groupId()>0&&d.ownerId()!=user)throw new BizException(ErrorCode.FORBIDDEN,"小组项目只能主动加入你拥有的文档");
        boolean added=projects.add(id,docId,user);if(added)projects.touch(id);return new Change(added);
    }
    @Transactional
    public Change remove(long id,long docId,String associationId) {
        long user=user();var access=access(id,true,false);var d=document(docId,user);
        if(!access.canManage()&&d.ownerId()!=user)throw new BizException(ErrorCode.FORBIDDEN,"只有文档所有者或项目管理者可以移出");
        if(associationId==null||associationId.length()!=36)throw bad("关联标识无效，请刷新");
        try { if(!UUID.fromString(associationId).toString().equalsIgnoreCase(associationId))throw bad("关联标识无效，请刷新"); }
        catch(IllegalArgumentException invalid) { throw bad("关联标识无效，请刷新"); }
        var current=projects.association(id,docId);
        if(current.isEmpty())return new Change(false);
        if(!current.get().equals(associationId))throw bad("关联已变化，请刷新项目文档后重试");
        projects.remove(id,docId,associationId);projects.touch(id);return new Change(true);
    }
    private ProjectRepository.Document document(long id,long user) {
        if(id<=0)throw bad("文档编号无效");
        var doc=projects.lockDocument(id,user).orElseThrow(()->new BizException(ErrorCode.NOT_FOUND));
        if(doc.permission()!=1&&doc.permission()!=2)throw new BizException(ErrorCode.FORBIDDEN);
        return doc;
    }
    private Access access(long id,boolean lock,boolean allowArchived) {
        long user=user();if(id<=0)throw bad("项目编号无效");
        var initial=projects.find(id,false).orElseThrow(()->new BizException(ErrorCode.NOT_FOUND));
        String groupName=null;boolean manage;
        if(initial.groupId()==0) {
            if(initial.ownerId()!=user)throw new BizException(ErrorCode.FORBIDDEN);
            manage=true;
        } else {
            var group=groups.access(initial.groupId(),lock);groupName=group.name();manage=group.canManage();
        }
        var current=lock?projects.find(id,true).orElseThrow(()->new BizException(ErrorCode.NOT_FOUND)):initial;
        if(current.groupId()!=initial.groupId()||current.ownerId()!=initial.ownerId())throw bad("项目归属已变化，请刷新");
        if(current.archived()&&!allowArchived)throw new BizException(ErrorCode.NOT_FOUND,"项目已归档");
        return new Access(current,groupName,manage);
    }
    private static void manage(Access access) { if(!access.canManage())throw new BizException(ErrorCode.FORBIDDEN,"需要项目管理权限"); }
    private static long user() {Long id=UserContext.getUserId();if(id==null||id<=0)throw new BizException(ErrorCode.UNAUTHORIZED);return id;}
    private static void paging(int p,int s) {if(p<1||p>1000000||s<1||s>100)throw bad("分页参数无效");}
    private static String filter(String value) {String s=value==null?"":value.trim();if(s.length()>200)throw bad("筛选最多200字符");return s;}
    private static String name(String value) {String s=value==null?"":value.trim();if(s.isEmpty()||s.length()>80||s.chars().anyMatch(Character::isISOControl))throw bad("项目名称需要1～80字符且无控制字符");return s;}
    private static String description(String value) {String s=value==null?"":value.trim();if(s.length()>300||s.chars().anyMatch(c->Character.isISOControl(c)&&c!='\n'&&c!='\r'))throw bad("项目简介最多300字符");return s;}
    private static BizException bad(String message) {return new BizException(ErrorCode.PARAM_ERROR,message);}
    private record Access(ProjectRepository.Project project,String groupName,boolean canManage) { }
    public record IdView(long id,long groupId) { }
    public record Change(boolean changed) { }
    public record ListView(long total,List<ProjectRepository.Summary> list) { }
    public record Detail(long id,String name,String description,long ownerId,long groupId,String groupName,boolean canManage,long total,List<ProjectRepository.DocumentSummary> list) { }
    public record Candidates(long total,List<ProjectRepository.Candidate> list) { }
}
