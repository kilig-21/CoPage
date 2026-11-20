package com.school.collab.config;

import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.flyway.FlywayAutoConfiguration;
import org.springframework.boot.test.context.ConfigDataApplicationContextInitializer;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.init.ResourceDatabasePopulator;

import javax.sql.DataSource;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

import static com.school.collab.testsupport.MySqlTestDatabase.create;
import static org.assertj.core.api.Assertions.assertThat;

@EnabledIfEnvironmentVariable(named = "COPAGE_MIGRATION_TEST_MYSQL", matches = ".+")
class DatabaseMigrationTest {
    private static final String HISTORY = "flyway_schema_history";

    @Test
    void emptyDatabaseMatchesTheLegacyBootstrapAndRecordsVersions() throws IOException {
        var clean = create();
        var bootstrap = create();
        String legacySchema = new ClassPathResource("db/schema.sql").getContentAsString(StandardCharsets.UTF_8)
                .replace("\r\n", "\n");
        execute(bootstrap, legacySchema.replaceFirst("(?m)^CREATE DATABASE[^\n]+\nUSE[^\n]+\n", ""));

        context(clean).withPropertyValues("spring.flyway.target=4").run(app -> {
            assertThat(app).hasNotFailed();
            assertThat(app.getBean(Flyway.class).getConfiguration().isCleanDisabled()).isTrue();
        });
        var cleanDb = new JdbcTemplate(clean);
        var bootstrapDb = new JdbcTemplate(bootstrap);
        var tables = bootstrapDb.queryForList("SHOW TABLES", String.class);
        assertThat(tables).hasSize(18);
        assertThat(cleanDb.queryForList("SHOW TABLES", String.class))
                .containsExactlyInAnyOrderElementsOf(java.util.stream.Stream.concat(
                        tables.stream(), java.util.stream.Stream.of(HISTORY)).toList());
        tables.forEach(table -> assertThat(createTable(cleanDb, table)).isEqualTo(createTable(bootstrapDb, table)));
        assertThat(versions(cleanDb)).containsExactly("1", "2", "3", "4");

        context(clean).run(app -> assertThat(app).hasNotFailed());
        context(bootstrap).run(app -> assertThat(app).hasNotFailed());
        assertThat(versions(cleanDb)).containsExactly("1", "2", "3", "4", "5", "6");
        assertThat(versions(bootstrapDb)).containsExactly("0", "1", "2", "3", "4", "5", "6");
        assertThat(createTable(cleanDb, "document")).isEqualTo(createTable(bootstrapDb, "document"));
    }

    @Test
    void baselinesLegacyCopyWithoutOverwritingDocumentsAccountsOrReceipts() throws IOException {
        var legacy = create();
        var jdbc = new JdbcTemplate(legacy);
        String oldDdl = baseline()
                .replace("  `credential_version` BIGINT NOT NULL DEFAULT 0,\n", "")
                .replace("  `request_hash` CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,\n", "")
                .replace("invitation_version BIGINT NOT NULL DEFAULT 1,", "")
                .replaceFirst("(?s)CREATE TABLE IF NOT EXISTS doc_creation_receipt \\(.*?;", "");
        execute(legacy, oldDdl);
        jdbc.update("INSERT INTO `user` (id, username, password, nickname) VALUES (7001, 'migration_fixture', 'fixture', '合成账号')");
        jdbc.update("INSERT INTO document (id, title, owner_id, content, revision) VALUES (7002, '合成文档', 7001, ?, 7)",
                "{\"ops\":[{\"insert\":\"迁移数据\\n\"}]}");
        jdbc.update("INSERT INTO doc_operation (doc_id, revision, op, user_id) VALUES (7002, 7, '{}', 7001)");
        jdbc.update("INSERT INTO doc_operation_receipt (doc_id, user_id, client_id, op_id, revision) VALUES (7002, 7001, 'cli', 'op', 7)");
        jdbc.update("INSERT INTO group_invitation (group_id, user_id, inviter_id, status) VALUES (7003, 7001, 7001, 'pending')");
        var documents = jdbc.queryForList("SELECT id,title,content,revision,owner_id,is_deleted,create_time,update_time FROM document");
        var operations = jdbc.queryForList("SELECT * FROM doc_operation");
        var accounts = jdbc.queryForList("SELECT id, username, password, nickname, create_time FROM `user`");

        context(legacy).run(app -> assertThat(app).hasNotFailed());
        assertThat(versions(jdbc)).containsExactly("0", "1", "2", "3", "4", "5", "6");
        assertThat(jdbc.queryForList("SELECT id,title,content,revision,owner_id,is_deleted,create_time,update_time FROM document"))
                .isEqualTo(documents);
        assertThat(jdbc.queryForObject("SELECT search_version FROM document WHERE id=7002", Long.class)).isEqualTo(1L);
        assertThat(jdbc.queryForObject("SELECT search_pending FROM document WHERE id=7002", Boolean.class)).isTrue();
        assertThat(jdbc.queryForList("SELECT * FROM doc_operation")).isEqualTo(operations);
        assertThat(jdbc.queryForList("SELECT id, username, password, nickname, create_time FROM `user`")).isEqualTo(accounts);
        assertThat(jdbc.queryForObject("SELECT credential_version FROM `user` WHERE id=7001", Long.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT request_hash FROM doc_operation_receipt WHERE revision=7", String.class)).isNull();
        assertThat(jdbc.queryForObject("SELECT invitation_version FROM group_invitation WHERE user_id=7001", Long.class)).isEqualTo(1L);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM doc_creation_receipt", Long.class)).isZero();

        context(legacy).run(app -> assertThat(app).hasNotFailed());
        assertThat(versions(jdbc)).containsExactly("0", "1", "2", "3", "4", "5", "6");
    }

    @Test
    void refusesWrongDatabaseAndLegacyTableCopyBeforeWritingMigrationHistory() throws IOException {
        var unrelated = create();
        var unrelatedDb = new JdbcTemplate(unrelated);
        unrelatedDb.execute("CREATE TABLE unrelated (id BIGINT PRIMARY KEY)");
        context(unrelated).run(app -> assertThat(app.getStartupFailure())
                .hasStackTraceContaining("非空数据库缺少旧版核心表结构"));
        assertThat(unrelatedDb.queryForList("SHOW TABLES", String.class)).containsExactly("unrelated");

        var legacy = create();
        execute(legacy, baseline().replace("`op` LONGTEXT NOT NULL", "`op` TEXT NOT NULL"));
        context(legacy).run(app -> assertThat(app.getStartupFailure())
                .hasStackTraceContaining("doc_operation.op 需要离线扩容"));
        assertThat(new JdbcTemplate(legacy).queryForList("SHOW TABLES", String.class)).doesNotContain(HISTORY);
    }

    private ApplicationContextRunner context(DataSource dataSource) {
        return new ApplicationContextRunner()
                .withInitializer(new ConfigDataApplicationContextInitializer())
                .withConfiguration(AutoConfigurations.of(FlywayAutoConfiguration.class))
                .withUserConfiguration(DatabaseMigrationConfig.class)
                .withBean(DataSource.class, () -> dataSource);
    }

    private static String baseline() throws IOException {
        return new ClassPathResource("db/migration/V1__baseline.sql").getContentAsString(StandardCharsets.UTF_8)
                .replace("\r\n", "\n");
    }

    private static void execute(DataSource dataSource, String sql) {
        var scripts = new ResourceDatabasePopulator(new ByteArrayResource(sql.getBytes(StandardCharsets.UTF_8)));
        scripts.setSqlScriptEncoding("UTF-8");
        scripts.execute(dataSource);
    }

    private static String createTable(JdbcTemplate jdbc, String table) {
        return jdbc.queryForMap("SHOW CREATE TABLE `" + table + "`").get("Create Table").toString();
    }

    private static java.util.List<String> versions(JdbcTemplate jdbc) {
        return jdbc.queryForList("SELECT version FROM " + HISTORY + " WHERE success ORDER BY installed_rank", String.class);
    }
}
