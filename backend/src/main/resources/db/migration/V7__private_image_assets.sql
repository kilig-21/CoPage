CREATE TABLE IF NOT EXISTS image_asset (
  object_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  owner_id BIGINT NULL,
  size_bytes BIGINT NOT NULL DEFAULT 0,
  media_type VARCHAR(32) CHARACTER SET ascii NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (object_key),
  KEY idx_image_asset_owner (owner_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS document_image_asset (
  doc_id BIGINT NOT NULL,
  object_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (doc_id, object_key),
  KEY idx_document_image_object (object_key, doc_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS template_image_asset (
  template_id BIGINT NOT NULL,
  object_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (template_id, object_key),
  KEY idx_template_image_object (object_key, template_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
