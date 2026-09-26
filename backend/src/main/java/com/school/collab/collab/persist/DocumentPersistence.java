package com.school.collab.collab.persist;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.collab.CollabException;
import com.school.collab.collab.store.CollabDocumentSnapshot;
import com.school.collab.collab.store.VersionedOperation;
import com.school.collab.ot.Delta;
import jakarta.annotation.PostConstruct;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

/** MySQL 是文档内容、版本和操作日志的持久化事实来源。 */
@Service
public class DocumentPersistence {
    private static final String CREATE_RECEIPT_TABLE = """
            CREATE TABLE IF NOT EXISTS `doc_operation_receipt` (
              `doc_id` BIGINT NOT NULL,
              `user_id` BIGINT NOT NULL,
              `client_id` VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
              `op_id` VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
              `revision` BIGINT NOT NULL,
              `request_hash` CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
              PRIMARY KEY (`doc_id`, `user_id`, `client_id`, `op_id`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """;

    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;

    public DocumentPersistence(JdbcTemplate jdbc, ObjectMapper mapper) {
        this.jdbc = jdbc;
        this.mapper = mapper;
    }

    /** 现有 MySQL 数据卷不会重新执行 schema.sql，因此启动时补齐幂等收据表。 */
    @PostConstruct
    public void ensureReceiptTable() {
        jdbc.execute(CREATE_RECEIPT_TABLE);
        if (!receiptHashColumnExists()) {
            try {
                jdbc.execute("""
                        ALTER TABLE doc_operation_receipt
                        ADD COLUMN request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL
                        """);
            } catch (DataAccessException exception) {
                // 双实例同时升级旧数据卷时，另一个实例可能已经加好列。
                if (!receiptHashColumnExists()) {
                    throw exception;
                }
            }
        }
    }

    private boolean receiptHashColumnExists() {
        Integer columns = jdbc.queryForObject("""
                SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doc_operation_receipt'
                  AND COLUMN_NAME = 'request_hash'
                """, Integer.class);
        return columns != null && columns > 0;
    }

    public Receipt receipt(long docId, long userId, String clientId, String opId) {
        List<Receipt> receipts = jdbc.query("""
                SELECT revision, request_hash FROM doc_operation_receipt
                WHERE doc_id = ? AND user_id = ? AND client_id = ? AND op_id = ?
                """, (rs, index) -> new Receipt(rs.getLong("revision"), rs.getString("request_hash")),
                docId, userId, clientId, opId);
        return receipts.isEmpty() ? null : receipts.getFirst();
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
        persistOperation(docId, expectedRevision, content, operation, userId);
    }

    /** 收据与正文、版本、操作日志同事务写入，避免提交成功但确认丢失时重放。 */
    @Transactional
    public void persist(long docId, long expectedRevision, Delta content, Delta operation,
                        Long userId, String clientId, String opId, String requestHash) {
        persistOperation(docId, expectedRevision, content, operation, userId);
        jdbc.update("""
                INSERT INTO doc_operation_receipt (doc_id, user_id, client_id, op_id, revision, request_hash)
                VALUES (?, ?, ?, ?, ?, ?)
                """, docId, userId, clientId, opId, expectedRevision + 1, requestHash);
    }

    private void persistOperation(long docId, long expectedRevision, Delta content,
                                  Delta operation, Long userId) {
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

    public record Receipt(long revision, String requestHash) {
    }
}
