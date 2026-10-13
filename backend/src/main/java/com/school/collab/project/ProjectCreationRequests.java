package com.school.collab.project;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.common.BizException;
import com.school.collab.common.ErrorCode;
import com.school.collab.common.UserContext;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.UUID;

/** 项目与首次编号同事务保存；重放仍须当前能访问原项目。 */
@Service
public class ProjectCreationRequests {
    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;
    private final ProjectService projects;

    public ProjectCreationRequests(JdbcTemplate jdbc,ObjectMapper mapper,ProjectService projects) {
        this.jdbc=jdbc;this.mapper=mapper;this.projects=projects;
    }

    @Transactional(isolation=Isolation.READ_COMMITTED)
    public ProjectService.IdView execute(String requestId,String name,String description,long groupId) {
        Long user=UserContext.getUserId();
        if(user==null||user<=0)throw new BizException(ErrorCode.UNAUTHORIZED);
        if(requestId==null)return projects.create(name,description,groupId);
        String key=canonicalId(requestId),hash=fingerprint(name,description,groupId);
        // upsert 持此回执行锁。只有新插入行可为0；已提交的0是坏回执，标负值后拒绝并回滚。
        jdbc.update("INSERT INTO project_creation_receipt(user_id,request_id,request_hash,project_id,group_id) VALUES(?,?,?,0,?) "
                +"ON DUPLICATE KEY UPDATE project_id=IF(project_id=0,-1,project_id)",user,key,hash,groupId);
        var rows=jdbc.query("SELECT request_hash,project_id,group_id FROM project_creation_receipt WHERE user_id=? AND request_id=?",
                (r,n)->new Receipt(r.getString(1),r.getLong(2),r.getLong(3)),user,key);
        if(rows.size()!=1)throw new IllegalStateException("项目创建回执无法读取");
        var receipt=rows.getFirst();
        if(!hash.equals(receipt.hash()))throw new BizException(ErrorCode.PARAM_ERROR,"创建标识已用于其他内容，请重新发起创建");
        if(receipt.projectId()<0||receipt.groupId()<0||receipt.groupId()!=groupId)
            throw new IllegalStateException("项目创建回执无效");
        if(receipt.projectId()>0)return projects.replayCreation(receipt.projectId(),receipt.groupId());
        var result=projects.create(name,description,groupId);
        if(result==null||result.id()<=0||result.groupId()!=groupId)throw new IllegalStateException("项目创建编号无效");
        int saved=jdbc.update("UPDATE project_creation_receipt SET project_id=? WHERE user_id=? AND request_id=? AND project_id=0",
                result.id(),user,key);
        if(saved!=1)throw new IllegalStateException("项目创建回执无法保存");
        return result;
    }

    String fingerprint(String name,String description,long groupId) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(mapper.writeValueAsBytes(new Object[]{"project:create:v1",new Input(name,description,groupId)})));
        } catch(Exception failure) {throw new IllegalStateException("项目创建请求无法校验",failure);}
    }
    private static String canonicalId(String raw) {
        try {
            String id=UUID.fromString(raw).toString();
            if(raw.length()==36&&id.equalsIgnoreCase(raw))return id;
        } catch(IllegalArgumentException ignored) { }
        throw new BizException(ErrorCode.PARAM_ERROR,"创建标识必须是有效的UUID");
    }
    private record Input(String name,String description,long groupId) { }
    private record Receipt(String hash,long projectId,long groupId) { }
}
