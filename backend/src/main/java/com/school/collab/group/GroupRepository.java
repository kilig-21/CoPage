package com.school.collab.group;

import jakarta.annotation.PostConstruct;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.datasource.init.ResourceDatabasePopulator;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.stereotype.Repository;
import java.sql.Statement;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Optional;
import java.util.Objects;

@Repository
public class GroupRepository {
    private static final java.time.format.DateTimeFormatter TIME=java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");
    private final JdbcTemplate jdbc;
    public GroupRepository(JdbcTemplate jdbc) { this.jdbc = jdbc; }
    @PostConstruct
    public void ensureTables() {
        new ResourceDatabasePopulator(new ClassPathResource("db/groups.sql"))
                .execute(Objects.requireNonNull(jdbc.getDataSource()));
        if (!hasInvitationVersion()) {
            try { jdbc.execute("ALTER TABLE group_invitation ADD COLUMN invitation_version BIGINT NOT NULL DEFAULT 1"); }
            catch (org.springframework.dao.DataAccessException failure) { if (!hasInvitationVersion()) throw failure; }
        }
    }
    private boolean hasInvitationVersion() {
        Integer count=jdbc.queryForObject("SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='group_invitation' AND COLUMN_NAME='invitation_version'",Integer.class);
        return count!=null&&count>0;
    }
    public long create(String name, String description, long owner) {
        var keys = new GeneratedKeyHolder();
        jdbc.update(c -> {
            var s = c.prepareStatement("INSERT INTO copage_group(name,description,owner_id) VALUES(?,?,?)", Statement.RETURN_GENERATED_KEYS);
            s.setString(1,name); s.setString(2,description); s.setLong(3,owner); return s;
        }, keys);
        return Objects.requireNonNull(keys.getKey()).longValue();
    }
    public Optional<Group> find(long id, boolean lock) {
        return jdbc.query("SELECT id,name,description,owner_id,is_archived FROM copage_group WHERE id=?" + (lock ? " FOR UPDATE" : ""),
                (r,n) -> new Group(r.getLong("id"),r.getString("name"),r.getString("description"),r.getLong("owner_id"),r.getBoolean("is_archived")), id).stream().findFirst();
    }
    public long count(long user, boolean archived) { return count(user,archived,""); }
    public long count(long user, boolean archived, String keyword) {
        return jdbc.queryForObject("""
            SELECT COUNT(*) FROM copage_group g JOIN group_member m ON m.group_id=g.id AND m.user_id=?
            WHERE g.is_archived=? AND (?='' OR LOCATE(?,g.name)>0 OR LOCATE(?,g.description)>0)
            """,Long.class,user,archived,keyword,keyword,keyword);
    }
    public List<Summary> list(long user, boolean archived, String keyword, int page, int size) {
        return jdbc.query("""
            SELECT g.id,g.name,g.description,g.owner_id,g.is_archived,g.update_time,m.role,
              (SELECT COUNT(*) FROM group_member x WHERE x.group_id=g.id) member_count
            FROM copage_group g JOIN group_member m ON m.group_id=g.id AND m.user_id=?
            WHERE g.is_archived=? AND (?='' OR LOCATE(?,g.name)>0 OR LOCATE(?,g.description)>0)
            ORDER BY g.update_time DESC,g.id DESC LIMIT ? OFFSET ?
            """, (r,n) -> new Summary(r.getLong("id"),r.getString("name"),r.getString("description"),
                r.getLong("owner_id"),r.getLong("owner_id")==user?"owner":r.getString("role"),
                r.getLong("member_count"),r.getBoolean("is_archived"),r.getTimestamp("update_time").toLocalDateTime().format(TIME)),
                user,archived,keyword,keyword,keyword,size,((long)page-1)*size);
    }
    public String role(long group, long user) {
        var roles=jdbc.query("SELECT role FROM group_member WHERE group_id=? AND user_id=?",(r,n)->r.getString(1),group,user);
        return roles.isEmpty()?null:roles.getFirst();
    }
    public String roleForUpdate(long group, long user) {
        var roles=jdbc.query("SELECT role FROM group_member WHERE group_id=? AND user_id=? FOR UPDATE",(r,n)->r.getString(1),group,user);
        return roles.isEmpty()?null:roles.getFirst();
    }
    public List<Member> members(long group) {
        return jdbc.query("""
            SELECT m.user_id,u.username,u.nickname,m.role,m.joined_at FROM group_member m JOIN user u ON u.id=m.user_id
            WHERE m.group_id=? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,m.joined_at,m.user_id
            """,(r,n)->new Member(r.getLong("user_id"),r.getString("username"),r.getString("nickname"),r.getString("role"),
                r.getTimestamp("joined_at").toLocalDateTime().format(TIME)),group);
    }
    public long memberCount(long group) { return jdbc.queryForObject("SELECT COUNT(*) FROM group_member WHERE group_id=?",Long.class,group); }
    public long pendingCount(long group) { return jdbc.queryForObject("SELECT COUNT(*) FROM group_invitation WHERE group_id=? AND status='pending'",Long.class,group); }
    public void add(long group,long user,String role) { jdbc.update("INSERT INTO group_member(group_id,user_id,role) VALUES(?,?,?)",group,user,role); }
    public void role(long group,long user,String role) { jdbc.update("UPDATE group_member SET role=? WHERE group_id=? AND user_id=?",role,group,user); }
    public void remove(long group,long user) { jdbc.update("DELETE FROM group_member WHERE group_id=? AND user_id=?",group,user); }
    public Optional<Account> account(String username) {
        return jdbc.query("SELECT id,username FROM user WHERE username=?",(r,n)->new Account(r.getLong(1),r.getString(2)),username).stream().findFirst();
    }
    public String invitation(long group,long user) {
        var statuses=jdbc.query("SELECT status FROM group_invitation WHERE group_id=? AND user_id=?",(r,n)->r.getString(1),group,user);
        return statuses.isEmpty()?null:statuses.getFirst();
    }
    public long invitationVersion(long group,long user) {
        var versions=jdbc.query("SELECT invitation_version FROM group_invitation WHERE group_id=? AND user_id=?",(r,n)->r.getLong(1),group,user);
        return versions.isEmpty()?0:versions.getFirst();
    }
    public void invite(long group,long user,long inviter) {
        jdbc.update("""
            INSERT INTO group_invitation(group_id,user_id,inviter_id,status) VALUES(?,?,?,'pending')
            ON DUPLICATE KEY UPDATE inviter_id=VALUES(inviter_id),status='pending',invitation_version=invitation_version+1,create_time=CURRENT_TIMESTAMP,update_time=CURRENT_TIMESTAMP
            """,group,user,inviter);
    }
    public void invitationStatus(long group,long user,String status) {
        jdbc.update("UPDATE group_invitation SET status=? WHERE group_id=? AND user_id=?",status,group,user);
    }
    public List<Pending> pending(long group) {
        return jdbc.query("""
            SELECT i.user_id,u.username,u.nickname,i.create_time,i.invitation_version FROM group_invitation i JOIN user u ON u.id=i.user_id
            WHERE i.group_id=? AND i.status='pending' ORDER BY i.create_time DESC,i.user_id
            """,(r,n)->new Pending(r.getLong(1),r.getString(2),r.getString(3),r.getTimestamp(4).toLocalDateTime().format(TIME),r.getLong(5)),group);
    }
    public long inboxCount(long user) {
        return jdbc.queryForObject("""
            SELECT COUNT(*) FROM group_invitation i JOIN copage_group g ON g.id=i.group_id
            WHERE i.user_id=? AND i.status='pending' AND g.is_archived=0
            """,Long.class,user);
    }
    public List<Invitation> inbox(long user,int page,int size) {
        return jdbc.query("""
            SELECT g.id,g.name,g.description,u.username,u.nickname,i.create_time,i.invitation_version
            FROM group_invitation i JOIN copage_group g ON g.id=i.group_id JOIN user u ON u.id=i.inviter_id
            WHERE i.user_id=? AND i.status='pending' AND g.is_archived=0 ORDER BY i.create_time DESC,g.id DESC LIMIT ? OFFSET ?
            """,(r,n)->new Invitation(r.getLong(1),r.getString(2),r.getString(3),r.getString(4),r.getString(5),
                r.getTimestamp(6).toLocalDateTime().format(TIME),r.getLong(7)),user,size,((long)page-1)*size);
    }
    public void rename(long id,String name,String description) { jdbc.update("UPDATE copage_group SET name=?,description=? WHERE id=?",name,description,id); }
    public void archive(long id,boolean archived) {
        jdbc.update("UPDATE copage_group SET is_archived=? WHERE id=?",archived,id);
        if(archived) jdbc.update("UPDATE group_invitation SET status='cancelled' WHERE group_id=? AND status='pending'",id);
    }
    public void touch(long id) { jdbc.update("UPDATE copage_group SET update_time=CURRENT_TIMESTAMP WHERE id=?",id); }
    public record Group(long id,String name,String description,long ownerId,boolean archived) { }
    public record Summary(long id,String name,String description,long ownerId,String role,long memberCount,boolean archived,String updateTime) { }
    public record Member(long userId,String username,String nickname,String role,String joinedAt) { }
    public record Account(long id,String username) { }
    public record Pending(long userId,String username,String nickname,String createdAt,long invitationVersion) { }
    public record Invitation(long groupId,String name,String description,String inviterUsername,String inviterNickname,String createdAt,long invitationVersion) { }
}
