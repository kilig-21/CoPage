SET @copage_ddl = IF(
    EXISTS(SELECT 1 FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user' AND COLUMN_NAME = 'credential_version'),
    'DO 0',
    'ALTER TABLE `user` ADD COLUMN credential_version BIGINT NOT NULL DEFAULT 0, ALGORITHM=INSTANT'
);
PREPARE copage_migration FROM @copage_ddl;
EXECUTE copage_migration;
DEALLOCATE PREPARE copage_migration;
