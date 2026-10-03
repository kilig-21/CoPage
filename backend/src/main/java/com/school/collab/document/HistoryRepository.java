package com.school.collab.document;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.collab.CollabException;
import com.school.collab.collab.persist.DocumentPersistence;
import com.school.collab.collab.store.CollabDocumentSnapshot;
import com.school.collab.ot.Delta;
import com.school.collab.ot.DeltaApply;
import jakarta.annotation.PostConstruct;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

/** 版本内容由基准快照和连续增量重建；命名版本单独保存，允许历史压缩后继续查看。 */
@Repository
public class HistoryRepository {
    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;
    private final DocumentPersistence persistence;

    public HistoryRepository(JdbcTemplate jdbc, ObjectMapper mapper, DocumentPersistence persistence) {
        this.jdbc = jdbc;
        this.mapper = mapper;
        this.persistence = persistence;
    }

    @PostConstruct
    public void ensureTables() {
        // 恢复操作可能包含整篇富文本，不能继续受 TEXT 的 64 KiB 限制。
        String operationType = jdbc.queryForObject("""
                SELECT DATA_TYPE FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doc_operation' AND COLUMN_NAME = 'op'
                """, String.class);
        if (!"longtext".equalsIgnoreCase(operationType)) {
            jdbc.execute("ALTER TABLE doc_operation MODIFY COLUMN op LONGTEXT NOT NULL");
        }
        jdbc.execute("""
            CREATE TABLE IF NOT EXISTS doc_history_boundary (
              doc_id BIGINT PRIMARY KEY, revision BIGINT NOT NULL,
              update_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """);
        jdbc.execute("""
            CREATE TABLE IF NOT EXISTS doc_named_version (
              doc_id BIGINT NOT NULL, revision BIGINT NOT NULL, name VARCHAR(100) NOT NULL,
              content LONGTEXT NOT NULL, user_id BIGINT NOT NULL,
              create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
              PRIMARY KEY (doc_id, revision)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """);
    }

    public long floor(long docId) {
        var rows = jdbc.query("SELECT revision FROM doc_history_boundary WHERE doc_id = ?",
                (rs, n) -> rs.getLong(1), docId);
        return rows.isEmpty() ? 0 : rows.getFirst();
    }

    public Delta contentAt(long docId, long revision, CollabDocumentSnapshot current) {
        if (revision < 0 || revision > current.revision()) {
            throw new CollabException(400, "版本号不在当前文档范围内");
        }
        if (revision == current.revision()) return current.content().copy();
        var named = jdbc.query("SELECT content FROM doc_named_version WHERE doc_id = ? AND revision = ?",
                (rs, n) -> decode(rs.getString(1)), docId, revision);
        if (!named.isEmpty()) return named.getFirst();
        long floor = floor(docId);
        if (revision < floor) throw new CollabException(40903, "该版本已超过历史保留范围");
        var snapshots = jdbc.query("""
                SELECT revision, content FROM doc_snapshot
                WHERE doc_id = ? AND revision <= ? ORDER BY revision DESC, id DESC LIMIT 1
                """, (rs, n) -> new CollabDocumentSnapshot(rs.getLong(1), decode(rs.getString(2))), docId, revision);
        var base = snapshots.isEmpty() ? new CollabDocumentSnapshot(0, new Delta().insert("\n")) : snapshots.getFirst();
        if (base.revision() < floor) throw new CollabException(40903, "历史基准快照缺失，拒绝还原不完整内容");
        Delta content = base.content();
        long expected = base.revision();
        for (var entry : persistence.operationsBetween(docId, base.revision(), revision)) {
            if (entry.revision() != ++expected) throw new CollabException(40903, "版本历史有缺口，无法还原");
            content = DeltaApply.apply(content, entry.operation());
        }
        if (expected != revision) throw new CollabException(40903, "版本历史不完整，无法还原");
        return content;
    }

    public List<VersionView> versions(long docId, long before, int limit) {
        return jdbc.query("""
                SELECT o.revision, o.create_time, u.nickname, n.name
                FROM doc_operation o LEFT JOIN user u ON o.user_id = u.id
                LEFT JOIN doc_named_version n ON n.doc_id = o.doc_id AND n.revision = o.revision
                WHERE o.doc_id = ? AND o.revision < ? ORDER BY o.revision DESC LIMIT ?
                """, (rs, n) -> new VersionView(rs.getLong(1), rs.getString(2), rs.getString(3), rs.getString(4)),
                docId, before, limit);
    }

    public List<VersionView> namedVersions(long docId) {
        return jdbc.query("""
                SELECT n.revision, n.create_time, u.nickname, n.name
                FROM doc_named_version n LEFT JOIN user u ON u.id = n.user_id
                WHERE n.doc_id = ? ORDER BY n.revision DESC
                """, (rs, n) -> new VersionView(rs.getLong(1), rs.getString(2), rs.getString(3), rs.getString(4)), docId);
    }

    /** 调用者持文档锁，限制重要版本数量与总字节数，避免无界保留完整正文。 */
    @Transactional
    public void name(long docId, long revision, String name, long userId, Delta content) {
        String json = encode(content);
        Long count = jdbc.queryForObject("SELECT COUNT(*) FROM doc_named_version WHERE doc_id = ? AND revision <> ?",
                Long.class, docId, revision);
        Long bytes = jdbc.queryForObject("SELECT COALESCE(SUM(OCTET_LENGTH(content)),0) FROM doc_named_version WHERE doc_id = ? AND revision <> ?",
                Long.class, docId, revision);
        if (count >= 20 || bytes + json.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > 32L * 1024 * 1024) {
            throw new CollabException(400, "重要版本最多 20 个、总正文最多 32 MiB，请先取消旧版本标记");
        }
        jdbc.update("""
                INSERT INTO doc_named_version(doc_id,revision,name,content,user_id) VALUES(?,?,?,?,?)
                ON DUPLICATE KEY UPDATE name=VALUES(name)
                """, docId, revision, name, json, userId);
    }

    public void unname(long docId, long revision) {
        jdbc.update("DELETE FROM doc_named_version WHERE doc_id = ? AND revision = ?", docId, revision);
    }

    private Delta decode(String json) {
        try { return mapper.readValue(json, Delta.class); }
        catch (JsonProcessingException ex) { throw new IllegalStateException("历史版本内容损坏", ex); }
    }

    private String encode(Delta content) {
        try { return mapper.writeValueAsString(content); }
        catch (JsonProcessingException ex) { throw new IllegalStateException("历史版本无法保存", ex); }
    }

    public record VersionView(long revision, String savedAt, String author, String name) { }
}
