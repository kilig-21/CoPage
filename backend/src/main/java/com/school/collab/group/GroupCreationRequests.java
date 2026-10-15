package com.school.collab.group;

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

/** 原请求与小组、创建者成员同事务保存；重放只确认原组，不修改其当前资料。 */
@Service
public class GroupCreationRequests {
    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;
    private final GroupService groups;

    public GroupCreationRequests(JdbcTemplate jdbc,ObjectMapper mapper,GroupService groups) {
        this.jdbc=jdbc;this.mapper=mapper;this.groups=groups;
    }

    @Transactional(isolation=Isolation.READ_COMMITTED)
    public GroupService.CreationView execute(String requestId,String name,String description) {
        Long user=UserContext.getUserId();
        if(user==null||user<=0)throw new BizException(ErrorCode.UNAUTHORIZED);
        if(requestId==null) {
            var created=groups.create(name,description);
            return currentCreation(created.id());
        }
        String key=canonicalId(requestId),hash=fingerprint(name,description);
        // upsert 持有此回执行锁。已提交的0为坏回执，标负值后拒绝并回滚，不能再次创建。
        jdbc.update("INSERT INTO group_creation_receipt(user_id,request_id,request_hash,group_id) VALUES(?,?,?,0) "
                +"ON DUPLICATE KEY UPDATE group_id=IF(group_id=0,-1,group_id)",user,key,hash);
        var rows=jdbc.query("SELECT request_hash,group_id FROM group_creation_receipt WHERE user_id=? AND request_id=?",
                (r,n)->new Receipt(r.getString(1),r.getLong(2)),user,key);
        if(rows.size()!=1)throw new IllegalStateException("小组创建回执无法读取");
        var receipt=rows.getFirst();
        if(!hash.equals(receipt.hash()))throw new BizException(ErrorCode.PARAM_ERROR,"创建标识已用于其他内容，请核对原请求");
        if(receipt.groupId()<0)throw new IllegalStateException("小组创建回执无效");
        if(receipt.groupId()>0) {
            return currentCreation(receipt.groupId());
        }
        var created=groups.create(name,description);
        if(created==null||created.id()<=0)throw new IllegalStateException("小组创建编号无效");
        int saved=jdbc.update("UPDATE group_creation_receipt SET group_id=? WHERE user_id=? AND request_id=? AND group_id=0",
                created.id(),user,key);
        if(saved!=1)throw new IllegalStateException("小组创建回执无法保存");
        return currentCreation(created.id());
    }

    private GroupService.CreationView currentCreation(long id) {
        var result=groups.replayCreation(id);
        if(result==null||result.id()!=id||result.name()==null||result.name().isBlank())
            throw new IllegalStateException("原小组创建资料无法确认");
        return result;
    }

    String fingerprint(String name,String description) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(mapper.writeValueAsBytes(new Object[]{"group:create:v1",new Input(name,description)})));
        } catch(Exception failure) {throw new IllegalStateException("小组创建请求无法校验",failure);}
    }
    private static String canonicalId(String raw) {
        try {
            String id=UUID.fromString(raw).toString();
            if(raw.length()==36&&id.equalsIgnoreCase(raw))return id;
        } catch(IllegalArgumentException ignored) { }
        throw new BizException(ErrorCode.PARAM_ERROR,"创建标识必须是有效的UUID");
    }
    private record Input(String name,String description) { }
    private record Receipt(String hash,long groupId) { }
}
