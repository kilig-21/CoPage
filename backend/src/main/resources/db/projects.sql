CREATE TABLE IF NOT EXISTS copage_project (
 id BIGINT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(80) NOT NULL,
 description VARCHAR(300) NOT NULL DEFAULT '', owner_id BIGINT NOT NULL,
 group_id BIGINT NOT NULL DEFAULT 0, is_archived TINYINT NOT NULL DEFAULT 0,
 create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 update_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 KEY idx_project_owner(owner_id,is_archived), KEY idx_project_group(group_id,is_archived)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS project_document (
 project_id BIGINT NOT NULL, doc_id BIGINT NOT NULL, association_id CHAR(36) NOT NULL,
 added_by BIGINT NOT NULL, create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(project_id,doc_id), KEY idx_project_document_doc(doc_id,project_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
