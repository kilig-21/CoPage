package com.school.collab.testsupport;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import javax.sql.DataSource;
import java.util.UUID;

/** Creates a private schema inside the disposable MySQL service used by CI. */
public final class MySqlTestDatabase {
    private MySqlTestDatabase() { }

    public static DataSource create() {
        var server = System.getenv("COPAGE_MIGRATION_TEST_MYSQL");
        var password = System.getenv("COPAGE_MIGRATION_TEST_PASSWORD");
        var name = "copage_test_" + UUID.randomUUID().toString().replace("-", "");
        var properties = "?allowPublicKeyRetrieval=true&sslMode=DISABLED&characterEncoding=UTF-8&rewriteBatchedStatements=true";
        var admin = new JdbcTemplate(new DriverManagerDataSource("jdbc:mysql://" + server + "/" + properties, "root", password));
        admin.execute("CREATE DATABASE " + name + " CHARACTER SET utf8mb4");
        return new DriverManagerDataSource("jdbc:mysql://" + server + "/" + name + properties, "root", password);
    }
}
