package com.school.collab.document;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.common.BizException;
import com.school.collab.common.ErrorCode;
import com.school.collab.common.UserContext;
import jakarta.annotation.PostConstruct;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.UUID;
import java.util.function.Supplier;

/** 创建正文与首次响应同事务保存；重试不能再次创建或覆盖已经创建的文档。 */
@Service
public class DocumentCreationRequests {
    static final String CREATE_TABLE = """
            CREATE TABLE IF NOT EXISTS doc_creation_receipt (
              user_id BIGINT NOT NULL,
              request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
              kind VARCHAR(80) NOT NULL,
              request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
              doc_id BIGINT NOT NULL,
              response_json TEXT NOT NULL,
              create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
              PRIMARY KEY (user_id, request_id), KEY idx_doc_creation_document(doc_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """;
    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;

    public DocumentCreationRequests(JdbcTemplate jdbc, ObjectMapper mapper) {
        this.jdbc = jdbc; this.mapper = mapper;
    }

    @PostConstruct public void ensureTable() { jdbc.execute(CREATE_TABLE); }

    @Transactional(isolation = Isolation.READ_COMMITTED)
    public <T extends CreatedDocument> T execute(String requestId, String kind, Object input,
                                               Class<T> responseType, Supplier<T> create) {
        Long user = UserContext.getUserId();
        if (user == null || user <= 0) throw new BizException(ErrorCode.UNAUTHORIZED);
        if (requestId == null) return create.get(); // 兼容既有客户端；没有标识的请求仍是独立创建。
        String key = canonicalId(requestId);
        String hash = fingerprint(kind, input);
        // 原子upsert取得此请求行的排他锁；不用INSERT IGNORE的共享锁，也不锁无关用户行。
        // 占位行仅在当前事务存在，创建或收据保存失败会一同回滚。
        jdbc.update("INSERT INTO doc_creation_receipt(user_id,request_id,kind,request_hash,doc_id,response_json) VALUES(?,?,?,?,0,'') "
                + "ON DUPLICATE KEY UPDATE request_id=request_id", user, key, kind, hash);
        var receipts = jdbc.query("SELECT kind, request_hash, response_json, doc_id FROM doc_creation_receipt WHERE user_id=? AND request_id=?",
                (rs, n) -> new Receipt(rs.getString(1), rs.getString(2), rs.getString(3), rs.getLong(4)), user, key);
        if (receipts.isEmpty()) throw new IllegalStateException("创建收据无法读取");
        var receipt = receipts.getFirst();
        if (!kind.equals(receipt.kind()) || !hash.equals(receipt.hash()))
            throw new BizException(ErrorCode.PARAM_ERROR, "创建标识已用于其他内容，请重新发起创建");
        if (!receipt.response().isEmpty()) {
            try {
                T result = mapper.readValue(receipt.response(), responseType);
                if (receipt.docId() <= 0 || result.id() != receipt.docId()) throw new IllegalStateException("创建收据编号不一致");
                return result;
            }
            catch (Exception failure) { throw new IllegalStateException("创建收据无法读取", failure); }
        }
        T result = create.get();
        try {
            String response = mapper.writeValueAsString(result);
            if (response.getBytes(StandardCharsets.UTF_8).length > 4096)
                throw new IllegalStateException("创建收据摘要超过限制");
            jdbc.update("UPDATE doc_creation_receipt SET doc_id=?,response_json=? WHERE user_id=? AND request_id=?",
                    result.id(), response, user, key);
            return result;
        } catch (com.fasterxml.jackson.core.JsonProcessingException failure) {
            throw new IllegalStateException("创建收据无法保存", failure);
        }
    }

    public Object importInput(MultipartFile file, String title) {
        if (file == null || file.isEmpty() || file.getSize() > DocumentTransfer.MAX_BYTES)
            throw new BizException(ErrorCode.PARAM_ERROR, "请选择不超过 1 MiB 的非空文件");
        try { return new ImportInput(title, file.getOriginalFilename(), HexFormat.of().formatHex(sha256(file.getBytes()))); }
        catch (java.io.IOException failure) { throw new BizException(ErrorCode.PARAM_ERROR, "文件无法读取，请重新选择"); }
    }

    String fingerprint(String kind, Object input) {
        try { return HexFormat.of().formatHex(sha256(mapper.writeValueAsBytes(new Object[]{kind, input}))); }
        catch (com.fasterxml.jackson.core.JsonProcessingException failure) {
            throw new IllegalStateException("创建请求无法校验", failure);
        }
    }
    private static byte[] sha256(byte[] bytes) {
        try { return MessageDigest.getInstance("SHA-256").digest(bytes); }
        catch (java.security.NoSuchAlgorithmException failure) { throw new IllegalStateException(failure); }
    }
    private static String canonicalId(String raw) {
        try {
            String id = UUID.fromString(raw).toString();
            if (raw.length() == 36 && id.equalsIgnoreCase(raw)) return id;
        } catch (IllegalArgumentException ignored) { }
        throw new BizException(ErrorCode.PARAM_ERROR, "创建标识必须是有效的UUID");
    }
    public interface CreatedDocument { long id(); }
    private record Receipt(String kind, String hash, String response, long docId) { }
    private record ImportInput(String title, String filename, String fileHash) { }
}
