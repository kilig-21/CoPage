package com.school.collab.document;

import com.school.collab.group.GroupRepository;
import com.school.collab.project.ProjectRepository;
import com.school.collab.template.PersonalTemplateRepository;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;

import java.sql.ResultSet;
import java.sql.Timestamp;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.List;
import java.util.TimeZone;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** DATETIME是数据库的年月日时分秒；各列表和详情不能随应用JVM时区改变。 */
class DatabaseDateTimeMappingTest {
    private static final LocalDateTime DATABASE_TIME = LocalDateTime.of(2026, 10, 10, 4, 27, 5);
    private static final String DISPLAY_TIME = "2026-10-10 04:27:05";

    private JdbcTemplate database() throws Exception {
        ResultSet row = mock(ResultSet.class);
        // Connector/J的Timestamp表示瞬时值，而LocalDateTime保留DATETIME的原字段。
        Timestamp instant = Timestamp.from(DATABASE_TIME.atZone(ZoneId.of("Asia/Shanghai")).toInstant());
        when(row.getTimestamp(anyString())).thenReturn(instant);
        when(row.getTimestamp(anyInt())).thenReturn(instant);
        when(row.getObject(anyString(), eq(LocalDateTime.class))).thenReturn(DATABASE_TIME);
        when(row.getObject(anyInt(), eq(LocalDateTime.class))).thenReturn(DATABASE_TIME);
        when(row.getLong(anyString())).thenReturn(1L);
        when(row.getLong(anyInt())).thenReturn(1L);
        when(row.getString(anyString())).thenReturn("fixture");
        when(row.getString(anyInt())).thenReturn("fixture");
        return mock(JdbcTemplate.class, invocation -> {
            if (invocation.getMethod().getName().equals("query") && invocation.getArgument(1) instanceof RowMapper<?> mapper)
                return List.of(mapper.mapRow(row, 0));
            return RETURNS_DEFAULTS.answer(invocation);
        });
    }

    private static void inBothTimeZones(Runnable check) {
        TimeZone original = TimeZone.getDefault();
        try {
            for (String zone : List.of("UTC", "Asia/Shanghai")) {
                TimeZone.setDefault(TimeZone.getTimeZone(zone));
                check.run();
            }
        } finally {
            TimeZone.setDefault(original);
        }
    }

    @Test void documentDetailListsAndTrashKeepTheDatabaseDateTime() throws Exception {
        var documents = new DocumentRepository(database());
        inBothTimeZones(() -> {
            assertEquals(DATABASE_TIME, documents.find(1).orElseThrow().updateTime());
            assertEquals(DATABASE_TIME, documents.findForUpdate(1).orElseThrow().updateTime());
            assertEquals(DATABASE_TIME, documents.findOwnedForUpdate(1, 1).orElseThrow().document().updateTime());
            assertEquals(DATABASE_TIME, documents.listVisible(1, "", "all", 1, 20).getFirst().updateTime());
            assertEquals(DATABASE_TIME, documents.listDeletedOwned(1, 1, 20).getFirst().deletedAt());
        });
    }

    @Test void groupAndInvitationTimesKeepTheDatabaseDateTime() throws Exception {
        var groups = new GroupRepository(database());
        inBothTimeZones(() -> {
            assertEquals(DISPLAY_TIME, groups.list(1, false, "", 1, 20).getFirst().updateTime());
            assertEquals(DISPLAY_TIME, groups.members(1).getFirst().joinedAt());
            assertEquals(DISPLAY_TIME, groups.pending(1).getFirst().createdAt());
            assertEquals(DISPLAY_TIME, groups.inbox(1, 1, 20).getFirst().createdAt());
        });
    }

    @Test void projectAndDocumentTimesKeepTheDatabaseDateTime() throws Exception {
        var projects = new ProjectRepository(database());
        inBothTimeZones(() -> {
            assertEquals(DISPLAY_TIME, projects.list(1, "all", 0, false, "", 1, 20).getFirst().updateTime());
            assertEquals(DISPLAY_TIME, projects.documents(1, 1, true, "", 1, 20).getFirst().updateTime());
        });
    }

    @Test void personalTemplateTimesKeepTheDatabaseDateTime() throws Exception {
        var templates = new PersonalTemplateRepository(database());
        inBothTimeZones(() -> assertEquals(DISPLAY_TIME, templates.list(1, "all", "", 1, 20).getFirst().updateTime()));
    }
}
