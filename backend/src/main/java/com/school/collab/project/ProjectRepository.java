package com.school.collab.project;

import jakarta.annotation.PostConstruct;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.datasource.init.ResourceDatabasePopulator;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.stereotype.Repository;
import java.sql.Statement;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;

@Repository
public class ProjectRepository {
    private static final java.time.format.DateTimeFormatter TIME=java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");
    private static final String FROM="""
        FROM copage_project p LEFT JOIN copage_group g ON g.id=p.group_id
        LEFT JOIN group_member gm ON gm.group_id=p.group_id AND gm.user_id=?
        """;
    private static final String FILTER="""
        WHERE ((p.group_id=0 AND p.owner_id=?) OR (p.group_id>0 AND g.is_archived=0 AND gm.user_id IS NOT NULL))
        AND p.is_archived=? AND (?='all' OR (?='personal' AND p.group_id=0) OR (?='group' AND p.group_id>0))
        AND (?=0 OR p.group_id=?) AND (?='' OR LOCATE(?,p.name)>0)
        """;
    private final JdbcTemplate jdbc;
    public ProjectRepository(JdbcTemplate jdbc) { this.jdbc=jdbc; }
    @PostConstruct public void ensureTables() {
        new ResourceDatabasePopulator(new ClassPathResource("db/projects.sql")).execute(Objects.requireNonNull(jdbc.getDataSource()));
    }
    public long create(String name,String description,long owner,long group) {
        var keys=new GeneratedKeyHolder();
        jdbc.update(c->{var s=c.prepareStatement("INSERT INTO copage_project(name,description,owner_id,group_id) VALUES(?,?,?,?)",Statement.RETURN_GENERATED_KEYS);
            s.setString(1,name);s.setString(2,description);s.setLong(3,owner);s.setLong(4,group);return s;},keys);
        return Objects.requireNonNull(keys.getKey()).longValue();
    }
    public Optional<Project> find(long id,boolean lock) {
        return jdbc.query("SELECT id,name,description,owner_id,group_id,is_archived FROM copage_project WHERE id=?"+(lock?" FOR UPDATE":""),
            (r,n)->new Project(r.getLong(1),r.getString(2),r.getString(3),r.getLong(4),r.getLong(5),r.getBoolean(6)),id).stream().findFirst();
    }
    public long count(long user,String scope,long group,boolean archived,String keyword) {
        return jdbc.queryForObject("SELECT COUNT(*) "+FROM+FILTER,Long.class,user,user,archived,scope,scope,scope,group,group,keyword,keyword);
    }
    public List<Summary> list(long user,String scope,long group,boolean archived,String keyword,int page,int size) {
        return jdbc.query("""
            SELECT p.id,p.name,p.description,p.owner_id,p.group_id,g.name group_name,p.is_archived,p.update_time,
              (p.group_id=0 OR g.owner_id=? OR gm.role='admin') can_manage,
              (SELECT COUNT(*) FROM project_document pd JOIN document d ON d.id=pd.doc_id
                 LEFT JOIN doc_collaborator c ON c.doc_id=d.id AND c.user_id=?
               WHERE pd.project_id=p.id AND d.is_deleted=0 AND (d.owner_id=? OR c.permission IN(1,2))) visible_count
            """+FROM+FILTER+" ORDER BY p.update_time DESC,p.id DESC LIMIT ? OFFSET ?",
            (r,n)->new Summary(r.getLong("id"),r.getString("name"),r.getString("description"),r.getLong("owner_id"),
                r.getLong("group_id"),r.getString("group_name"),r.getBoolean("is_archived"),r.getBoolean("can_manage"),
                r.getLong("visible_count"),r.getObject("update_time", LocalDateTime.class).format(TIME)),
            user,user,user,user,user,archived,scope,scope,scope,group,group,keyword,keyword,size,((long)page-1)*size);
    }
    public void rename(long id,String name,String description) { jdbc.update("UPDATE copage_project SET name=?,description=? WHERE id=?",name,description,id); }
    public void archive(long id,boolean archived) { jdbc.update("UPDATE copage_project SET is_archived=? WHERE id=?",archived,id); }
    public void touch(long id) { jdbc.update("UPDATE copage_project SET update_time=CURRENT_TIMESTAMP WHERE id=?",id); }
    public Optional<Document> lockDocument(long doc,long user) {
        return jdbc.query("""
            SELECT d.id,d.owner_id,CASE WHEN d.owner_id=? THEN 2 ELSE COALESCE(c.permission,0) END permission
            FROM document d LEFT JOIN doc_collaborator c ON c.doc_id=d.id AND c.user_id=?
            WHERE d.id=? AND d.is_deleted=0 FOR UPDATE
            """,(r,n)->new Document(r.getLong(1),r.getLong(2),r.getInt(3)),user,user,doc).stream().findFirst();
    }
    public boolean add(long project,long doc,long user) {
        return jdbc.update("INSERT IGNORE INTO project_document(project_id,doc_id,association_id,added_by) VALUES(?,?,?,?)",
            project,doc,UUID.randomUUID().toString(),user)==1;
    }
    public Optional<String> association(long project,long doc) {
        return jdbc.query("SELECT association_id FROM project_document WHERE project_id=? AND doc_id=? FOR UPDATE",(r,n)->r.getString(1),project,doc).stream().findFirst();
    }
    public void remove(long project,long doc,String association) {
        jdbc.update("DELETE FROM project_document WHERE project_id=? AND doc_id=? AND association_id=?",project,doc,association);
    }
    public long documentCount(long project,long user,String keyword) {
        return jdbc.queryForObject("""
            SELECT COUNT(*) FROM project_document pd JOIN document d ON d.id=pd.doc_id
            LEFT JOIN doc_collaborator c ON c.doc_id=d.id AND c.user_id=?
            WHERE pd.project_id=? AND d.is_deleted=0 AND (d.owner_id=? OR c.permission IN(1,2))
            AND (?='' OR LOCATE(?,d.title)>0)
            """,Long.class,user,project,user,keyword,keyword);
    }
    public List<DocumentSummary> documents(long project,long user,boolean manage,String keyword,int page,int size) {
        return jdbc.query("""
            SELECT d.id,d.title,d.owner_id,u.nickname,pd.association_id,d.update_time,
              CASE WHEN d.owner_id=? THEN 2 ELSE c.permission END permission,
              (d.owner_id=? OR ?) can_remove
            FROM project_document pd JOIN document d ON d.id=pd.doc_id JOIN user u ON u.id=d.owner_id
            LEFT JOIN doc_collaborator c ON c.doc_id=d.id AND c.user_id=?
            WHERE pd.project_id=? AND d.is_deleted=0 AND (d.owner_id=? OR c.permission IN(1,2))
            AND (?='' OR LOCATE(?,d.title)>0)
            ORDER BY d.update_time DESC,d.id DESC LIMIT ? OFFSET ?
            """,(r,n)->new DocumentSummary(r.getLong(1),r.getString(2),r.getLong(3),r.getString(4),r.getString(5),
                r.getObject(6, LocalDateTime.class).format(TIME),r.getInt(7),r.getBoolean(8)),
            user,user,manage,user,project,user,keyword,keyword,size,((long)page-1)*size);
    }
    private static final String CANDIDATES="""
        FROM document d LEFT JOIN doc_collaborator c ON c.doc_id=d.id AND c.user_id=?
        WHERE d.is_deleted=0 AND (d.owner_id=? OR (?=false AND c.permission IN(1,2)))
        AND NOT EXISTS(SELECT 1 FROM project_document pd WHERE pd.project_id=? AND pd.doc_id=d.id)
        AND (?='' OR LOCATE(?,d.title)>0)
        """;
    public long candidateCount(long project,long user,boolean group,String keyword) {
        return jdbc.queryForObject("SELECT COUNT(*) "+CANDIDATES,Long.class,user,user,group,project,keyword,keyword);
    }
    public List<Candidate> candidates(long project,long user,boolean group,String keyword,int page,int size) {
        return jdbc.query("SELECT d.id,d.title,CASE WHEN d.owner_id=? THEN 2 ELSE c.permission END permission "+CANDIDATES+
                " ORDER BY d.update_time DESC,d.id DESC LIMIT ? OFFSET ?",
            (r,n)->new Candidate(r.getLong(1),r.getString(2),r.getInt(3)),user,user,user,group,project,keyword,keyword,size,((long)page-1)*size);
    }
    public record Project(long id,String name,String description,long ownerId,long groupId,boolean archived) { }
    public record Summary(long id,String name,String description,long ownerId,long groupId,String groupName,boolean archived,boolean canManage,long visibleDocumentCount,String updateTime) { }
    public record Document(long id,long ownerId,int permission) { }
    public record DocumentSummary(long id,String title,long ownerId,String ownerName,String associationId,String updateTime,int permission,boolean canRemove) { }
    public record Candidate(long id,String title,int permission) { }
}
