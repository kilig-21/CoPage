package com.school.collab.config;

import org.springframework.boot.autoconfigure.flyway.FlywayMigrationStrategy;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.List;

@Configuration(proxyBeanMethods = false)
public class DatabaseMigrationConfig {
    @Bean
    FlywayMigrationStrategy migrateDatabase() {
        return flyway -> {
            var jdbc = new JdbcTemplate(flyway.getConfiguration().getDataSource());
            var tables = jdbc.queryForList("""
                    SELECT TABLE_NAME FROM information_schema.TABLES
                    WHERE TABLE_SCHEMA = DATABASE()
                    """, String.class);
            if (!tables.isEmpty() && !tables.contains(flyway.getConfiguration().getTable())) {
                Integer coreColumns = jdbc.queryForObject("""
                        SELECT COUNT(*) FROM information_schema.COLUMNS
                        WHERE TABLE_SCHEMA = DATABASE() AND (
                            (TABLE_NAME = 'user' AND COLUMN_NAME IN ('id','username','password'))
                            OR (TABLE_NAME = 'document' AND COLUMN_NAME IN ('id','revision','owner_id','content'))
                            OR (TABLE_NAME = 'doc_operation' AND COLUMN_NAME IN ('doc_id','revision','op'))
                            OR (TABLE_NAME = 'doc_snapshot' AND COLUMN_NAME IN ('doc_id','revision','content'))
                        )
                        """, Integer.class);
                if (!tables.containsAll(List.of("user", "document", "doc_operation", "doc_snapshot"))
                        || coreColumns == null || coreColumns != 13) {
                    throw new IllegalStateException("CoPage 数据库迁移中止：非空数据库缺少旧版核心表结构，请核对目标数据库。");
                }
                String type = jdbc.queryForObject("""
                        SELECT DATA_TYPE FROM information_schema.COLUMNS
                        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'doc_operation' AND COLUMN_NAME = 'op'
                        """, String.class);
                if (!"longtext".equalsIgnoreCase(type)) {
                    throw new IllegalStateException(
                            "CoPage 数据库迁移中止：doc_operation.op 需要离线扩容为 LONGTEXT，请参阅《数据库结构迁移》并先在备份副本验证。");
                }
            }
            flyway.migrate();
        };
    }
}
