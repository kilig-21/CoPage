SET @copage_ddl = IF(
    EXISTS(SELECT 1 FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'group_invitation' AND COLUMN_NAME = 'invitation_version'),
    'DO 0',
    'ALTER TABLE group_invitation ADD COLUMN invitation_version BIGINT NOT NULL DEFAULT 1, ALGORITHM=INSTANT'
);
PREPARE copage_migration FROM @copage_ddl;
EXECUTE copage_migration;
DEALLOCATE PREPARE copage_migration;
