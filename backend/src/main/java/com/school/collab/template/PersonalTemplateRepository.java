package com.school.collab.template;

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
public class PersonalTemplateRepository {
    private static final java.time.format.DateTimeFormatter TIME=java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");
    private static final String FILTER=" WHERE owner_id=? AND (?='all' OR category=?) AND (?='' OR LOCATE(?,name)>0 OR LOCATE(?,description)>0)";
    private final JdbcTemplate jdbc;
    public PersonalTemplateRepository(JdbcTemplate jdbc) {this.jdbc=jdbc;}
    @PostConstruct public void ensureTables() {
        new ResourceDatabasePopulator(new ClassPathResource("db/personal-templates.sql")).execute(Objects.requireNonNull(jdbc.getDataSource()));
    }
    public void lockOwner(long user) {
        // Duplicate INSERT IGNORE holds a shared lock: concurrent upgrades can deadlock.
        // The upsert takes the exclusive owner lock before any quota/source reads.
        jdbc.update("INSERT INTO personal_template_owner(user_id) VALUES(?) ON DUPLICATE KEY UPDATE user_id=?",user,user);
        jdbc.queryForObject("SELECT user_id FROM personal_template_owner WHERE user_id=? FOR UPDATE",Long.class,user);
    }
    public Usage usage(long user) {
        return jdbc.queryForObject("SELECT COUNT(*),COALESCE(SUM(content_bytes),0) FROM personal_template WHERE owner_id=?",
            (r,n)->new Usage(r.getLong(1),r.getLong(2)),user);
    }
    public long count(long user,String category,String keyword) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM personal_template"+FILTER,Long.class,user,category,category,keyword,keyword,keyword);
    }
    public List<Summary> list(long user,String category,String keyword,int page,int size) {
        return jdbc.query("SELECT id,name,description,category,source_revision,version,update_time FROM personal_template"+FILTER+" ORDER BY update_time DESC,id DESC LIMIT ? OFFSET ?",
            (r,n)->new Summary(r.getLong(1),r.getString(2),r.getString(3),r.getString(4),r.getLong(5),r.getLong(6),r.getObject(7, LocalDateTime.class).format(TIME)),
            user,category,category,keyword,keyword,keyword,size,((long)page-1)*size);
    }
    public Optional<Template> find(long id,boolean lock) {
        return jdbc.query("SELECT id,owner_id,name,description,category,content,source_revision,version FROM personal_template WHERE id=?"+(lock?" FOR UPDATE":""),
            (r,n)->new Template(r.getLong(1),r.getLong(2),r.getString(3),r.getString(4),r.getString(5),r.getString(6),r.getLong(7),r.getLong(8)),id).stream().findFirst();
    }
    public Optional<Source> source(long id,long user) {
        return jdbc.query("""
            SELECT d.content,d.revision,CASE WHEN d.owner_id=? THEN 2 ELSE COALESCE(c.permission,0) END permission
            FROM document d LEFT JOIN doc_collaborator c ON c.doc_id=d.id AND c.user_id=?
            WHERE d.id=? AND d.is_deleted=0 FOR UPDATE
            """,(r,n)->new Source(r.getString(1),r.getLong(2),r.getInt(3)),user,user,id).stream().findFirst();
    }
    public long create(long user,String name,String description,String category,String content,int bytes,long revision) {
        var keys=new GeneratedKeyHolder();
        jdbc.update(c->{var s=c.prepareStatement("INSERT INTO personal_template(owner_id,name,description,category,content,content_bytes,source_revision) VALUES(?,?,?,?,?,?,?)",Statement.RETURN_GENERATED_KEYS);
            s.setLong(1,user);s.setString(2,name);s.setString(3,description);s.setString(4,category);s.setString(5,content);s.setInt(6,bytes);s.setLong(7,revision);return s;},keys);
        return Objects.requireNonNull(keys.getKey()).longValue();
    }
    public void update(long id,String name,String description,String category) {
        jdbc.update("UPDATE personal_template SET name=?,description=?,category=?,version=version+1 WHERE id=?",name,description,category,id);
    }
    public void delete(long id) {jdbc.update("DELETE FROM personal_template WHERE id=?",id);}
    public record Usage(long count,long bytes) { }
    public record Summary(long id,String name,String description,String category,long sourceRevision,long version,String updateTime) { }
    public record Template(long id,long ownerId,String name,String description,String category,String content,long sourceRevision,long version) { }
    public record Source(String content,long revision,int permission) { }
}
