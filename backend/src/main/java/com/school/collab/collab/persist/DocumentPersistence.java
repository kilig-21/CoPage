package com.school.collab.collab.persist;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.collab.CollabException;
import com.school.collab.collab.store.CollabDocumentSnapshot;
import com.school.collab.collab.store.VersionedOperation;
import com.school.collab.ot.Delta;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

/** MySQL 是文档内容、版本和操作日志的持久化事实来源。 */
@Service
public class DocumentPersistence {
    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;

    public DocumentPersistence(JdbcTemplate jdbc, ObjectMapper mapper) {
        this.jdbc = jdbc;
        this.mapper = mapper;
    }

    public CollabDocumentSnapshot snapshot(long docId) {
        List<CollabDocumentSnapshot> rows = jdbc.query(
                "SELECT content, revision FROM document WHERE id = ? AND is_deleted = 0",
                (rs, index) -> new CollabDocumentSnapshot(
                        rs.getLong("revision"), read(rs.getString("content"))), docId);
        if (rows.isEmpty()) {
            throw new CollabException(404, "文档不存在或已删除");
        }
        return rows.getFirst();
    }

    public List<VersionedOperation> operationsAfter(long docId, long baseRevision) {
        return jdbc.query("""
                SELECT revision, op FROM doc_operation
                WHERE doc_id = ? AND revision > ? ORDER BY revision ASC
                """, (rs, index) -> new VersionedOperation(
                rs.getLong("revision"), read(rs.getString("op"))), docId, baseRevision);
    }

    public boolean operationExists(long docId, long revision) {
        Integer count = jdbc.queryForObject(
                "SELECT COUNT(*) FROM doc_operation WHERE doc_id = ? AND revision = ?",
                Integer.class, docId, revision);
        return count != null && count > 0;
    }

    /** 巡检漏发消息的文档；一次只取有限批次，下一轮继续补齐。 */
    public List<Long> snapshotCandidates(int interval) {
        return jdbc.query("""
                SELECT d.id FROM document d
                LEFT JOIN (
                    SELECT doc_id, MAX(revision) AS revision
                    FROM doc_snapshot GROUP BY doc_id
                ) s ON s.doc_id = d.id
                WHERE d.is_deleted = 0 AND d.revision - COALESCE(s.revision, 0) >= ?
                ORDER BY d.id LIMIT 100
                """, (rs, index) -> rs.getLong(1), interval);
    }

    /** 锁住文档行后检查并保存快照，重复 MQ 消息和多实例消费都不会重复插入。 */
    @Transactional
    public void saveSnapshotIfNeeded(long docId, int interval) {
        List<CollabDocumentSnapshot> rows = jdbc.query(
                "SELECT content, revision FROM document WHERE id = ? AND is_deleted = 0 FOR UPDATE",
                (rs, index) -> new CollabDocumentSnapshot(
                        rs.getLong("revision"), read(rs.getString("content"))), docId);
        if (rows.isEmpty()) {
            return;
        }
        CollabDocumentSnapshot current = rows.getFirst();
        Long last = jdbc.queryForObject(
                "SELECT COALESCE(MAX(revision), 0) FROM doc_snapshot WHERE doc_id = ?",
                Long.class, docId);
        if (current.revision() - (last == null ? 0 : last) >= interval) {
            jdbc.update("INSERT INTO doc_snapshot (doc_id, revision, content) VALUES (?, ?, ?)",
                    docId, current.revision(), write(current.content()));
        }
    }

    /** CAS 更新文档与追加操作日志同处一个事务；任一步失败都会回滚。 */
    @Transactional
    public void persist(long docId, long expectedRevision, Delta content, Delta operation, Long userId) {
        int updated = jdbc.update("""
                UPDATE document SET content = ?, revision = revision + 1,
                       update_time = CURRENT_TIMESTAMP
                WHERE id = ? AND revision = ? AND is_deleted = 0
                """, write(content), docId, expectedRevision);
        if (updated != 1) {
            throw new CollabException(40902, "文档版本已变化，请重新同步");
        }
        jdbc.update("INSERT INTO doc_operation (doc_id, revision, op, user_id) VALUES (?, ?, ?, ?)",
                docId, expectedRevision + 1, write(operation), userId);
    }

    private Delta read(String json) {
        if (json == null) {
            return new Delta().insert("\n");
        }
        try {
            return mapper.readValue(json, Delta.class);
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException("数据库中的 Delta 内容损坏", exception);
        }
    }

    private String write(Delta delta) {
        try {
            return mapper.writeValueAsString(delta);
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException("无法序列化 Delta", exception);
        }
    }
}
