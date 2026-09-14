CREATE DATABASE IF NOT EXISTS collab_docs DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE collab_docs;

CREATE TABLE IF NOT EXISTS `user` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `username` VARCHAR(50) NOT NULL,
  `password` VARCHAR(100) NOT NULL,
  `nickname` VARCHAR(50),
  `avatar` VARCHAR(255),
  `create_time` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_user_username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `document` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `title` VARCHAR(200) NOT NULL DEFAULT '未命名文档',
  `content` LONGTEXT,
  `revision` BIGINT NOT NULL DEFAULT 0,
  `owner_id` BIGINT NOT NULL,
  `parent_id` BIGINT NOT NULL DEFAULT 0,
  `is_deleted` TINYINT NOT NULL DEFAULT 0,
  `create_time` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `update_time` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY `idx_document_owner` (`owner_id`),
  KEY `idx_document_parent` (`parent_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `doc_operation` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `doc_id` BIGINT NOT NULL,
  `revision` BIGINT NOT NULL,
  `op` TEXT NOT NULL,
  `user_id` BIGINT,
  `create_time` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_doc_operation_doc_revision` (`doc_id`, `revision`),
  KEY `idx_doc_operation_doc` (`doc_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `doc_snapshot` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `doc_id` BIGINT NOT NULL,
  `revision` BIGINT NOT NULL,
  `content` LONGTEXT NOT NULL,
  `create_time` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY `idx_doc_snapshot_doc_revision` (`doc_id`, `revision`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `doc_collaborator` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `doc_id` BIGINT NOT NULL,
  `user_id` BIGINT NOT NULL,
  `permission` TINYINT NOT NULL DEFAULT 2 COMMENT '1=只读，2=可编辑',
  `create_time` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_doc_collaborator_doc_user` (`doc_id`, `user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- testA / testB 的初始密码均为 123456（BCrypt，cost=10）。
INSERT IGNORE INTO `user` (`username`, `password`, `nickname`) VALUES
  ('testA', '$2a$10$6nYTSUSh2BQfbOLIyCXn8eUViBcnn.WcjUrW0tJLMND0dAtI85zMa', '测试用户 A'),
  ('testB', '$2a$10$6nYTSUSh2BQfbOLIyCXn8eUViBcnn.WcjUrW0tJLMND0dAtI85zMa', '测试用户 B');
