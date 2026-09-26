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
            (d.owner_id = ? OR EXISTS (
                SELECT 1 FROM doc_collaborator c
                WHERE c.doc_id = d.id AND c.user_id = ?
            )) AND (? = '' OR d.title LIKE CONCAT('%', ?, '%'))
            """;
    private static final RowMapper<DocumentRow> ROW_MAPPER = (rs, rowNum) -> new DocumentRow(
            rs.getLong("id"),
            rs.getString("title"),
            rs.getString("content"),
            rs.getLong("revision"),
            rs.getLong("owner_id"),
            rs.getString("owner_name"),
            rs.getLong("parent_id"),
            rs.getTimestamp("update_time").toLocalDateTime()
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

    public int collaboratorPermission(long docId, long userId) {
        List<Integer> permissions = jdbc.query(
                "SELECT permission FROM doc_collaborator WHERE doc_id = ? AND user_id = ?",
                (rs, rowNum) -> rs.getInt(1), docId, userId);
        return permissions.isEmpty() ? 0 : permissions.get(0);
    }

    public long countVisible(long userId, String keyword) {
        return jdbc.queryForObject(
                "SELECT COUNT(*) FROM document d WHERE " + VISIBLE_FILTER,
                Long.class, userId, userId, keyword, keyword);
    }

    public List<DocumentRow> listVisible(long userId, String keyword, int page, int size) {
        long offset = ((long) page - 1) * size;
        return jdbc.query("""
                SELECT d.id, d.title, d.content, d.revision, d.owner_id,
                       u.nickname AS owner_name, d.parent_id, d.update_time
                FROM document d JOIN user u ON u.id = d.owner_id
                WHERE
                """ + VISIBLE_FILTER + """
                ORDER BY d.update_time DESC, d.id DESC
                LIMIT ? OFFSET ?
                """, ROW_MAPPER, userId, userId, keyword, keyword, size, offset);
    }

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

    public record DocumentRow(
            long id, String title, String content, long revision,
            long ownerId, String ownerName, long parentId, LocalDateTime updateTime
    ) {
    }
}
