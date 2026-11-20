SET @copage_ddl = IF(
    EXISTS(SELECT 1 FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doc_operation_receipt' AND COLUMN_NAME = 'request_hash'),
    'DO 0',
    'ALTER TABLE doc_operation_receipt ADD COLUMN request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL, ALGORITHM=INSTANT'
);
PREPARE copage_migration FROM @copage_ddl;
EXECUTE copage_migration;
DEALLOCATE PREPARE copage_migration;
