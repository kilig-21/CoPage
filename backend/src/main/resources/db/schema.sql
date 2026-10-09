SET NAMES utf8mb4;
CREATE DATABASE IF NOT EXISTS collab_doc DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE collab_doc;

CREATE TABLE IF NOT EXISTS `user` (
  `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
  `username` VARCHAR(50) NOT NULL,
  `password` VARCHAR(100) NOT NULL,
  `credential_version` BIGINT NOT NULL DEFAULT 0,
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
  `op` LONGTEXT NOT NULL,
  `user_id` BIGINT,
  `create_time` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_doc_operation_doc_revision` (`doc_id`, `revision`),
  KEY `idx_doc_operation_doc` (`doc_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `doc_operation_receipt` (
  `doc_id` BIGINT NOT NULL,
  `user_id` BIGINT NOT NULL,
  `client_id` VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `op_id` VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `revision` BIGINT NOT NULL,
  `request_hash` CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (`doc_id`, `user_id`, `client_id`, `op_id`)
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

CREATE TABLE IF NOT EXISTS `doc_history_boundary` (
  `doc_id` BIGINT PRIMARY KEY,
  `revision` BIGINT NOT NULL,
  `update_time` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `doc_named_version` (
  `doc_id` BIGINT NOT NULL,
  `revision` BIGINT NOT NULL,
  `name` VARCHAR(100) NOT NULL,
  `content` LONGTEXT NOT NULL,
  `user_id` BIGINT NOT NULL,
  `create_time` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`doc_id`, `revision`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS copage_group (
 id BIGINT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(80) NOT NULL,
 description VARCHAR(300) NOT NULL DEFAULT '', owner_id BIGINT NOT NULL,
 is_archived TINYINT NOT NULL DEFAULT 0,
 create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 update_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 KEY idx_group_owner(owner_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS group_member (
 group_id BIGINT NOT NULL, user_id BIGINT NOT NULL, role VARCHAR(10) NOT NULL,
 joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(group_id,user_id), KEY idx_group_member_user(user_id,group_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS group_invitation (
 group_id BIGINT NOT NULL, user_id BIGINT NOT NULL, inviter_id BIGINT NOT NULL,
 status VARCHAR(12) NOT NULL DEFAULT 'pending', invitation_version BIGINT NOT NULL DEFAULT 1,
 create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 update_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 PRIMARY KEY(group_id,user_id), KEY idx_group_invitation_user(user_id,status,group_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
