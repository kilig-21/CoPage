package com.school.collab.storage;

import com.school.collab.common.BizException;
import com.school.collab.common.ErrorCode;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

@Repository
public class ImageAssetRepository {
    private final JdbcTemplate jdbc;

    public ImageAssetRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public Usage lockOwnerAndReadUsage(long userId) {
        var owners = jdbc.query("SELECT id FROM user WHERE id=? FOR UPDATE", (row, n) -> row.getLong(1), userId);
        if (owners.isEmpty()) throw new BizException(ErrorCode.UNAUTHORIZED);
        return jdbc.queryForObject("""
                SELECT COUNT(*), COALESCE(SUM(size_bytes), 0) FROM image_asset WHERE owner_id=?
                """, (row, n) -> new Usage(row.getLong(1), row.getLong(2)), userId);
    }

    public void create(String key, long ownerId, long sizeBytes, String mediaType) {
        jdbc.update("INSERT INTO image_asset (object_key, owner_id, size_bytes, media_type) VALUES (?,?,?,?)",
                key, ownerId, sizeBytes, mediaType);
    }

    public Optional<String> readableMediaType(String key, long userId) {
        return jdbc.query("""
                SELECT asset.media_type
                  FROM image_asset asset
                 WHERE asset.object_key = ?
                   AND (asset.owner_id = ?
                     OR EXISTS (
                        SELECT 1 FROM document_image_asset ref
                        JOIN document doc ON doc.id = ref.doc_id AND doc.is_deleted = 0
                        LEFT JOIN doc_collaborator member ON member.doc_id = doc.id AND member.user_id = ?
                         WHERE ref.object_key = asset.object_key
                           AND (doc.owner_id = ? OR member.permission IN (1, 2)))
                     OR EXISTS (
                        SELECT 1 FROM template_image_asset ref
                        JOIN personal_template template ON template.id = ref.template_id
                         WHERE ref.object_key = asset.object_key AND template.owner_id = ?))
                """, (row, n) -> row.getString(1), key, userId, userId, userId, userId).stream().findFirst();
    }

    public void associateDocument(long docId, String key) {
        jdbc.update("""
                INSERT INTO document_image_asset (doc_id, object_key) VALUES (?, ?)
                ON DUPLICATE KEY UPDATE object_key = document_image_asset.object_key
                """, docId, key);
    }

    public void associateTemplate(long templateId, String key) {
        jdbc.update("""
                INSERT INTO template_image_asset (template_id, object_key) VALUES (?, ?)
                ON DUPLICATE KEY UPDATE object_key = template_image_asset.object_key
                """, templateId, key);
    }

    public void removeTemplateReferences(long templateId) {
        jdbc.update("DELETE FROM template_image_asset WHERE template_id=?", templateId);
    }

    public record Usage(long count, long bytes) { }
}
