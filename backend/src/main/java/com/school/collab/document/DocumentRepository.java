package com.school.collab.document;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.stereotype.Repository;

import java.sql.PreparedStatement;
import java.sql.Statement;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Optional;

@Repository
public class DocumentRepository {
    private static final String VISIBLE_FILTER = """
            d.is_deleted = 0 AND
            (d.owner_id = ? OR c.user_id IS NOT NULL)
            AND (? = '' OR LOCATE(?, d.title) > 0)
            AND (? = 'all' OR (? = 'owned' AND d.owner_id = ?)
                 OR (? = 'shared' AND d.owner_id <> ?))
            """;
    private static final RowMapper<DocumentRow> ROW_MAPPER = (rs, rowNum) -> new DocumentRow(
            rs.getLong("id"),
            rs.getString("title"),
            rs.getString("content"),
            rs.getLong("revision"),
            rs.getLong("owner_id"),
            rs.getString("owner_name"),
            rs.getLong("parent_id"),
            rs.getObject("update_time", LocalDateTime.class)
    );

    private final JdbcTemplate jdbc;

    public DocumentRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public long create(String title, long ownerId, long parentId, String content) {
        GeneratedKeyHolder keys = new GeneratedKeyHolder();
        jdbc.update(connection -> {
            PreparedStatement statement = connection.prepareStatement(
                    "INSERT INTO document (title, content, revision, owner_id, parent_id) VALUES (?, ?, 0, ?, ?)",
                    Statement.RETURN_GENERATED_KEYS);
            statement.setString(1, title);
            statement.setString(2, content);
            statement.setLong(3, ownerId);
            statement.setLong(4, parentId);
            return statement;
        }, keys);
        return keys.getKey().longValue();
    }

    public Optional<DocumentRow> find(long docId) {
        List<DocumentRow> rows = jdbc.query("""
                SELECT d.id, d.title, d.content, d.revision, d.owner_id,
                       u.nickname AS owner_name, d.parent_id, d.update_time
                FROM document d JOIN user u ON u.id = d.owner_id
                WHERE d.id = ? AND d.is_deleted = 0
                """, ROW_MAPPER, docId);
        return rows.stream().findFirst();
    }

    /** 与新建文档同事务保存，保证模板初始版本可被历史恢复。 */
    public void saveInitialSnapshot(long docId, String content) {
        jdbc.update("INSERT INTO doc_snapshot(doc_id,revision,content) VALUES(?,0,?)", docId, content);
    }

    public int collaboratorPermission(long docId, long userId) {
        List<Integer> permissions = jdbc.query(
                "SELECT permission FROM doc_collaborator WHERE doc_id = ? AND user_id = ?",
                (rs, rowNum) -> rs.getInt(1), docId, userId);
        return permissions.isEmpty() ? 0 : permissions.get(0);
    }

    public Optional<DocumentRow> findForUpdate(long docId) {
        return jdbc.query("""
                SELECT d.id, d.title, d.content, d.revision, d.owner_id,
                       u.nickname AS owner_name, d.parent_id, d.update_time
                FROM document d JOIN user u ON u.id = d.owner_id
                WHERE d.id = ? AND d.is_deleted = 0 FOR UPDATE
                """, ROW_MAPPER, docId).stream().findFirst();
    }

    public Optional<AccountView> accountByUsername(String username) {
        return jdbc.query("SELECT id, username, nickname FROM user WHERE username = ?",
                (rs, index) -> new AccountView(rs.getLong("id"), rs.getString("username"),
                        rs.getString("nickname")), username).stream().findFirst();
    }

    public List<CollaboratorView> collaborators(long docId) {
        return jdbc.query("""
                SELECT c.user_id, u.username, u.nickname, c.permission
                FROM doc_collaborator c JOIN user u ON u.id = c.user_id
                WHERE c.doc_id = ? ORDER BY c.id
                """, (rs, index) -> new CollaboratorView(rs.getLong("user_id"),
                rs.getString("username"), rs.getString("nickname"), rs.getInt("permission")), docId);
    }

    public void addCollaborator(long docId, long userId, int permission) {
        jdbc.update("INSERT INTO doc_collaborator (doc_id, user_id, permission) VALUES (?, ?, ?)",
                docId, userId, permission);
    }

    public void changeCollaborator(long docId, long userId, int permission) {
        jdbc.update("UPDATE doc_collaborator SET permission = ? WHERE doc_id = ? AND user_id = ?",
                permission, docId, userId);
    }

    public void removeCollaborator(long docId, long userId) {
        jdbc.update("DELETE FROM doc_collaborator WHERE doc_id = ? AND user_id = ?", docId, userId);
    }

    public record AccountView(long id, String username, String nickname) { }

    public record CollaboratorView(long userId, String username, String nickname, int permission) { }

    public long countVisible(long userId, String keyword, String scope) {
        return jdbc.queryForObject(
                "SELECT COUNT(*) FROM document d LEFT JOIN doc_collaborator c ON c.doc_id=d.id AND c.user_id=? WHERE " + VISIBLE_FILTER,
                Long.class, userId, userId, keyword, keyword, scope, scope, userId, scope, userId);
    }

    /** 列表只取摘要；成员权限与正文可见性在同一次查询中计算，避免逐篇补查。 */
    public List<VisibleSummaryRow> listVisible(long userId, String keyword, String scope, int page, int size) {
        long offset = ((long) page - 1) * size;
        return jdbc.query("""
                SELECT d.id, d.title, d.owner_id,
                       u.nickname AS owner_name, d.parent_id, d.update_time,
                       CASE WHEN d.owner_id = ? THEN 2 ELSE c.permission END AS permission
                FROM document d JOIN user u ON u.id = d.owner_id
                LEFT JOIN doc_collaborator c ON c.doc_id = d.id AND c.user_id = ?
                WHERE
                """ + VISIBLE_FILTER + """
                ORDER BY d.update_time DESC, d.id DESC
                LIMIT ? OFFSET ?
                """, (rs, index) -> new VisibleSummaryRow(rs.getLong("id"), rs.getString("title"),
                rs.getLong("owner_id"), rs.getString("owner_name"), rs.getLong("parent_id"),
                rs.getObject("update_time", LocalDateTime.class), rs.getInt("permission")),
                userId, userId, userId, keyword, keyword, scope, scope, userId, scope, userId, size, offset);
    }

    public record VisibleSummaryRow(long id, String title, long ownerId, String ownerName,
                                    long parentId, LocalDateTime updateTime, int permission) { }

    /** 搜索前在数据库计算权限边界，ES 不保存或推断协作者权限。 */
    public List<Long> visibleIds(long userId) {
        return jdbc.query("""
                SELECT d.id FROM document d
                WHERE d.is_deleted = 0 AND
                      (d.owner_id = ? OR EXISTS (
                          SELECT 1 FROM doc_collaborator c
                          WHERE c.doc_id = d.id AND c.user_id = ?
                      ))
                """, (rs, index) -> rs.getLong(1), userId, userId);
    }

    /** 包括软删除文档，以便周期巡检清除索引里的旧条目。 */
    public List<Long> allIds() {
        return jdbc.query("SELECT id FROM document ORDER BY id", (rs, index) -> rs.getLong(1));
    }

    public boolean rename(long docId, String title) {
        return jdbc.update(
                "UPDATE document SET title = ?, update_time = CURRENT_TIMESTAMP WHERE id = ? AND is_deleted = 0",
                title, docId) == 1;
    }

    public boolean softDelete(long docId) {
        return jdbc.update(
                "UPDATE document SET is_deleted = 1, update_time = CURRENT_TIMESTAMP WHERE id = ? AND is_deleted = 0",
                docId) == 1;
    }

    public long countDeletedOwned(long userId) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM document WHERE owner_id=? AND is_deleted=1", Long.class, userId);
    }

    public List<TrashRow> listDeletedOwned(long userId, int page, int size) {
        return jdbc.query("""
            SELECT id,title,update_time FROM document WHERE owner_id=? AND is_deleted=1
            ORDER BY update_time DESC,id DESC LIMIT ? OFFSET ?
            """, (rs,n) -> new TrashRow(rs.getLong("id"),rs.getString("title"),rs.getObject("update_time", LocalDateTime.class)),
            userId,size,((long)page-1)*size);
    }

    /** 只锁当前所有者自己的文档，包含已删除行；并发/重试恢复不会改写正文。 */
    public Optional<OwnedState> findOwnedForUpdate(long docId, long userId) {
        return jdbc.query("""
            SELECT d.id,d.title,d.content,d.revision,d.owner_id,u.nickname AS owner_name,d.parent_id,d.update_time,d.is_deleted
            FROM document d JOIN user u ON u.id=d.owner_id WHERE d.id=? AND d.owner_id=? FOR UPDATE
            """, (rs,n)->new OwnedState(ROW_MAPPER.mapRow(rs,n),rs.getBoolean("is_deleted")),docId,userId).stream().findFirst();
    }

    public boolean restoreDeleted(long docId, long ownerId) {
        return jdbc.update("UPDATE document SET is_deleted=0,update_time=CURRENT_TIMESTAMP WHERE id=? AND owner_id=? AND is_deleted=1",
            docId,ownerId)==1;
    }

    public record TrashRow(long id,String title,LocalDateTime deletedAt) { }
    public record OwnedState(DocumentRow document,boolean deleted) { }

    public record DocumentRow(
            long id, String title, String content, long revision,
            long ownerId, String ownerName, long parentId, LocalDateTime updateTime
    ) {
    }
}
