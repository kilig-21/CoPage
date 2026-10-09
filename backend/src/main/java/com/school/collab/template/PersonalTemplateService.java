package com.school.collab.template;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.common.BizException;
import com.school.collab.common.ErrorCode;
import com.school.collab.common.UserContext;
import com.school.collab.document.DocumentService;
import com.school.collab.document.DocumentFormats;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Set;

@Service
public class PersonalTemplateService {
    private static final Set<String> CATEGORIES=Set.of("collaboration","planning","learning");
    private static final long COUNT_LIMIT=100,BYTE_LIMIT=32L*1024*1024;
    private final PersonalTemplateRepository templates;
    private final DocumentService documents;
    private final ObjectMapper mapper;
    public PersonalTemplateService(PersonalTemplateRepository templates,DocumentService documents,ObjectMapper mapper) {
        this.templates=templates;this.documents=documents;this.mapper=mapper;
    }
    @Transactional(readOnly=true)
    public ListView list(String category,String keyword,int page,int size) {
        long user=user();category(category,true);
        if(page<1||page>1000000||size<1||size>100)throw bad("分页参数无效");
        String filter=keyword==null?"":keyword.trim();if(filter.length()>200)throw bad("筛选最多200字符");
        return new ListView(templates.count(user,category,filter),templates.list(user,category,filter,page,size),templates.usage(user),COUNT_LIMIT,BYTE_LIMIT);
    }
    @Transactional(readOnly=true)
    public Detail detail(long id) {var t=owned(id,false);return new Detail(t.id(),t.name(),t.description(),t.category(),snapshot(t.content()).content(),t.sourceRevision(),t.version());}
    @Transactional
    public Created create(long docId,String name,String description,String category) {
        long user=user();String title=name(name),about=description(description);category(category,false);
        if(docId<=0)throw bad("请选择原文档");
        templates.lockOwner(user);
        var source=templates.source(docId,user).orElseThrow(()->new BizException(ErrorCode.NOT_FOUND));
        if(source.permission()!=1&&source.permission()!=2)throw new BizException(ErrorCode.FORBIDDEN);
        var snapshot=snapshot(source.content());String serialized=snapshot.serialized();int bytes=snapshot.bytes();
        var usage=templates.usage(user);
        if(usage.count()>=COUNT_LIMIT||usage.bytes()+bytes>BYTE_LIMIT)throw bad("个人模板最多100份、正文合计32 MiB，请先删除不再需要的模板");
        long id=templates.create(user,title,about,category,serialized,bytes,source.revision());
        return new Created(id,source.revision());
    }
    @Transactional
    public void update(long id,String name,String description,String category,long expectedVersion) {
        long user=user();String title=name(name),about=description(description);category(category,false);
        templates.lockOwner(user);var t=owned(id,true);version(t,expectedVersion);
        templates.update(id,title,about,category);
    }
    @Transactional
    public void delete(long id,long expectedVersion) {
        templates.lockOwner(user());var t=owned(id,true);version(t,expectedVersion);templates.delete(id);
    }
    @Transactional
    public DocumentService.SummaryView instantiate(long id,String title,long expectedVersion) {
        user();var t=owned(id,true);version(t,expectedVersion);
        return documents.createImported(title==null?t.name():title,snapshot(t.content()).content());
    }
    private PersonalTemplateRepository.Template owned(long id,boolean lock) {
        long user=user();if(id<=0)throw bad("模板编号无效");
        var t=templates.find(id,lock).orElseThrow(()->new BizException(ErrorCode.NOT_FOUND));
        if(t.ownerId()!=user)throw new BizException(ErrorCode.FORBIDDEN);return t;
    }
    private Snapshot snapshot(String serialized) {
        if(serialized==null)throw bad("原文档内容不能用作模板");
        try {
            JsonNode node=mapper.readTree(serialized),ops=node.path("ops");
            if(!node.isObject()||node.size()!=1||!ops.isArray()||ops.isEmpty())throw bad("原文档内容不能用作模板");
            String normalized=mapper.writeValueAsString(node);int bytes=normalized.getBytes(StandardCharsets.UTF_8).length;
            if(bytes>2*1024*1024)throw bad("模板正文最多2 MiB");
            for(JsonNode op:ops) {
                if(!op.has("insert"))throw bad("原文档内容不能用作模板");
                DocumentFormats.validateEditorOperation(mapper.createObjectNode().set("ops",mapper.createArrayNode().add(op)));
            }
            if(!ops.get(ops.size()-1).path("insert").asText().endsWith("\n"))throw bad("原文档内容不能用作模板");
            return new Snapshot(node,normalized,bytes);
        } catch(BizException failure) {throw failure;}
        catch(Exception failure) {throw bad("原文档内容不能用作模板");}
    }
    private record Snapshot(JsonNode content,String serialized,int bytes) { }
    private static void version(PersonalTemplateRepository.Template t,long expected) {if(expected<=0||t.version()!=expected)throw bad("模板已变化，请重新读取后再操作");}
    private static void category(String category,boolean all) {if((category==null||!CATEGORIES.contains(category))&&!(all&&"all".equals(category)))throw bad("模板分类无效");}
    private static String name(String input) {String s=input==null?"":input.trim();if(s.isEmpty()||s.length()>200||s.chars().anyMatch(Character::isISOControl))throw bad("模板名称需要1～200字符且无控制字符");return s;}
    private static String description(String input) {String s=input==null?"":input.trim();if(s.length()>300||s.chars().anyMatch(c->Character.isISOControl(c)&&c!='\n'&&c!='\r'))throw bad("模板说明最多300字符");return s;}
    private static long user() {Long id=UserContext.getUserId();if(id==null||id<=0)throw new BizException(ErrorCode.UNAUTHORIZED);return id;}
    private static BizException bad(String message) {return new BizException(ErrorCode.PARAM_ERROR,message);}
    public record ListView(long total,List<PersonalTemplateRepository.Summary> list,PersonalTemplateRepository.Usage usage,long countLimit,long byteLimit) { }
    public record Detail(long id,String name,String description,String category,JsonNode content,long sourceRevision,long version) { }
    public record Created(long id,long sourceRevision) { }
}
