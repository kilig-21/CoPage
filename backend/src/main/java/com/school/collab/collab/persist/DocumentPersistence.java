package com.school.collab.collab.persist;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.collab.CollabException;
import com.school.collab.collab.store.CollabDocumentSnapshot;
import com.school.collab.collab.store.VersionedOperation;
import com.school.collab.ot.Delta;
import com.school.collab.storage.ImageAssetRepository;
import com.school.collab.storage.ImageGrants;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.List;

/** MySQL 是文档内容、版本和操作日志的持久化事实来源。 */
@Service
public class DocumentPersistence {
    private static final int HISTORY_PAGE_BYTES = 1024 * 1024;
    private static final int MAX_OPERATION_BYTES = 4 * 1024 * 1024;
    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;
    private final ImageGrants imageGrants;

    public DocumentPersistence(JdbcTemplate jdbc, ObjectMapper mapper) {
        this(jdbc, mapper, new ImageGrants(new ImageAssetRepository(jdbc), mapper));
    }

    @Autowired
    public DocumentPersistence(JdbcTemplate jdbc, ObjectMapper mapper, ImageGrants imageGrants) {
        this.jdbc = jdbc;
        this.mapper = mapper;
        this.imageGrants = imageGrants;
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

    public long currentRevision(long docId) {
        List<Long> revisions = jdbc.query(
                "SELECT revision FROM document WHERE id = ? AND is_deleted = 0",
                (rs, index) -> rs.getLong("revision"), docId);
        if (revisions.isEmpty()) {
            throw new CollabException(404, "文档不存在或已删除");
        }
        return revisions.getFirst();
    }

    public long minimumRevision(long docId) {
        var rows = jdbc.query("SELECT revision FROM doc_history_boundary WHERE doc_id = ?",
                (rs, n) -> rs.getLong(1), docId);
        return rows.isEmpty() ? 0 : rows.getFirst();
    }

    public List<VersionedOperation> operationsPage(long docId, long after, long through, int limit) {
        return operationsBatch(docId, after, through, limit).operations();
    }

    public OperationBatch operationsBatch(long docId, long after, long through, int limit) {
        // Keep only revision and length in MySQL's bounded window result. Fetch the
        // actual LONGTEXT values only for the selected page.
        return jdbc.query("""
                SELECT history.revision, history.op, page.op_bytes FROM (
                    SELECT revision, op_bytes, SUM(op_bytes) OVER(ORDER BY revision) AS cumulative_bytes FROM (
                        SELECT revision, OCTET_LENGTH(op) AS op_bytes FROM doc_operation
                        WHERE doc_id = ? AND revision > ? AND revision <= ?
                        ORDER BY revision LIMIT ?
                    ) candidates
                ) page JOIN doc_operation history ON history.doc_id = ? AND history.revision = page.revision
                WHERE page.cumulative_bytes <= ? OR (page.revision = ? AND page.op_bytes <= ?)
                ORDER BY history.revision
                """, rs -> {
            List<VersionedOperation> operations = new ArrayList<>();
            long bytes = 0;
            while (rs.next()) {
                operations.add(new VersionedOperation(rs.getLong(1), read(rs.getString(2))));
                bytes += rs.getLong(3);
            }
            return new OperationBatch(operations, bytes);
        }, docId, after, through, limit, docId, HISTORY_PAGE_BYTES, after + 1, MAX_OPERATION_BYTES);
    }

    public record OperationBatch(List<VersionedOperation> operations, long bytes) {
        public boolean fitsInlineHistory() { return bytes <= HISTORY_PAGE_BYTES; }
    }

    public boolean operationExists(long docId, long revision) {
        Integer count = jdbc.queryForObject(
                "SELECT COUNT(*) FROM doc_operation WHERE doc_id = ? AND revision = ?",
                Integer.class, docId, revision);
        return count != null && count > 0;
    }

    /** 巡检漏发消息的文档；一次只取有限批次，下一轮继续补齐。 */
    public List<Long> snapshotCandidates(int interval, long after, int limit) {
        return jdbc.query("""
                SELECT d.id FROM document d
                WHERE d.id > ? AND d.is_deleted = 0 AND d.revision - COALESCE((
                    SELECT s.revision FROM doc_snapshot s WHERE s.doc_id = d.id
                    ORDER BY s.revision DESC LIMIT 1
                ), 0) >= ?
                ORDER BY d.id LIMIT ?
                """, (rs, index) -> rs.getLong(1), after, interval, limit);
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
        String contentJson = write(content);
        String operationJson = write(operation);
        validateSerializedSize(contentJson, operationJson);
        requireCurrentEditor(docId, userId);
        if (userId != null) imageGrants.attachToDocument(docId, userId, operationJson);
        int updated = jdbc.update("""
                UPDATE document SET content = ?, revision = revision + 1,
                       update_time = CURRENT_TIMESTAMP, search_version = search_version + 1, search_pending = TRUE
                WHERE id = ? AND revision = ? AND is_deleted = 0
                """, contentJson, docId, expectedRevision);
        if (updated != 1) {
            throw new CollabException(40902, "文档版本已变化，请重新同步");
        }
        jdbc.update("INSERT INTO doc_operation (doc_id, revision, op, user_id) VALUES (?, ?, ?, ?)",
                docId, expectedRevision + 1, operationJson, userId);
    }

    /** Check a generated restore before applying a potentially fragmented
     * operation; persistence still enforces the same limits transactionally. */
    public void validateSize(Delta content, Delta operation) {
        validateSerializedSize(write(content), write(operation));
    }

    private void validateSerializedSize(String contentJson, String operationJson) {
        if (contentJson.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > 2 * 1024 * 1024
                || operationJson.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > MAX_OPERATION_BYTES) {
            throw new CollabException(400, "文档正文最多 2 MiB，单次修改最多 4 MiB；图片使用上传地址保存");
        }
    }

    private void requireCurrentEditor(long docId, Long userId) {
        // null 只用于已接受的旧 Redis 历史补写，不把历史作者冒充当前编辑者。
        if (userId == null) return;
        if (userId <= 0) throw new CollabException(403, "当前用户没有文档编辑权限");
        // 与协作者变更共用 SQL 文档行锁；仅在 Redis 锁内复查仍会跨过权限事务。
        var owners = jdbc.query("SELECT owner_id FROM document WHERE id = ? AND is_deleted = 0 FOR UPDATE",
                (rs, n) -> rs.getLong("owner_id"), docId);
        if (owners.isEmpty()) throw new CollabException(404, "文档不存在或已删除");
        if (owners.getFirst().longValue() == userId.longValue()) return;
        // 当前锁读不依赖外层事务可能已有的普通读取快照。
        var permissions = jdbc.query("SELECT permission FROM doc_collaborator WHERE doc_id = ? AND user_id = ? FOR UPDATE",
                (rs, n) -> rs.getInt("permission"), docId, userId);
        if (permissions.isEmpty() || permissions.getFirst() != 2)
            throw new CollabException(403, "当前用户没有文档编辑权限");
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
