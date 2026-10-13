package com.school.collab.document;

import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;

import java.sql.ResultSet;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class DocumentRepositoryTest {
    @Test
    void trashCountAndPageUseIdenticalOwnerDeletedAndLiteralTitleConditionsWithoutReadingBodies() throws Exception {
        for (String keyword : new String[]{"", "%", "_", "50%_方案", "正文中的词", "' OR 1=1"}) {
            var queries = new ArrayList<String>();
            var row = mock(ResultSet.class);
            var deletedAt = LocalDateTime.of(2026, 10, 13, 20, 0);
            when(row.getLong("id")).thenReturn(11L);
            when(row.getString("title")).thenReturn("50%_方案");
            when(row.getObject("update_time", LocalDateTime.class)).thenReturn(deletedAt);
            var jdbc = mock(JdbcTemplate.class, invocation -> {
                String sql = invocation.<String>getArgument(0).replaceAll("\\s+", " ").trim().toLowerCase(Locale.ROOT);
                queries.add(sql);
                assertEquals(2L, (long) invocation.getArgument(2));
                assertEquals(keyword, invocation.getArgument(3));
                assertEquals(keyword, invocation.getArgument(4));
                if (invocation.getMethod().getName().equals("queryForObject")) {
                    assertTrue(sql.startsWith("select count(*) from document where "));
                    assertEquals(Long.class, invocation.getArgument(1));
                    return 3L;
                }
                assertEquals("query", invocation.getMethod().getName());
                assertTrue(sql.startsWith("select id,title,update_time from document where "));
                assertTrue(sql.endsWith("order by update_time desc,id desc limit ? offset ?"));
                assertEquals(1, (int) invocation.getArgument(5));
                assertEquals(1L, (long) invocation.getArgument(6));
                RowMapper<?> mapper = invocation.getArgument(1);
                return List.of(mapper.mapRow(row, 0));
            });
            var repository = new DocumentRepository(jdbc);
            assertEquals(3L, repository.countDeletedOwned(2L, keyword));
            assertEquals(List.of(new DocumentRepository.TrashRow(11L, "50%_方案", deletedAt)),
                    repository.listDeletedOwned(2L, keyword, 2, 1));
            String countFilter = queries.get(0).substring(queries.get(0).indexOf("where ") + 6);
            String listFilter = queries.get(1).substring(queries.get(1).indexOf("where ") + 6,
                    queries.get(1).indexOf(" order by "));
            assertEquals(countFilter, listFilter);
            assertEquals("owner_id = ? and is_deleted = 1 and (? = '' or locate(?, title) > 0)", countFilter);
            for (String query : queries) {
                assertFalse(query.contains("content"));
                assertFalse(query.contains("collaborator"));
                assertFalse(query.contains(" like "));
                assertFalse(query.contains(" join "));
                assertFalse(query.contains("for update"));
            }
            verify(row).getLong("id");
            verify(row).getString("title");
            verify(row).getObject("update_time", LocalDateTime.class);
            verifyNoMoreInteractions(row);
        }
    }

    @Test
    void legacyTrashQueriesUseAnEmptyFilterAndLargePagingKeepsTheOffsetAsLong() {
        var jdbc = mock(JdbcTemplate.class, invocation -> {
            assertEquals(7L, (long) invocation.getArgument(2));
            assertEquals("", invocation.getArgument(3));
            assertEquals("", invocation.getArgument(4));
            if (invocation.getMethod().getName().equals("queryForObject")) return 0L;
            assertEquals("query", invocation.getMethod().getName());
            assertEquals(100, (int) invocation.getArgument(5));
            assertEquals(((long) Integer.MAX_VALUE - 1) * 100, (long) invocation.getArgument(6));
            return List.of();
        });
        var repository = new DocumentRepository(jdbc);
        assertEquals(0L, repository.countDeletedOwned(7L));
        assertTrue(repository.listDeletedOwned(7L, Integer.MAX_VALUE, 100).isEmpty());
    }
}
