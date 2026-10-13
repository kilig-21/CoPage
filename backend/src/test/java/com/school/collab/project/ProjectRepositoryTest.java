package com.school.collab.project;

import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import java.sql.ResultSet;
import java.util.List;
import java.util.Locale;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class ProjectRepositoryTest {
    private static final String ASSOCIATION="11111111-1111-4111-8111-111111111111";

    @Test void associationProjectionUsesCurrentDocumentVisibilityAndNeverReadsBodyOrLocks() throws Exception {
        var row=mock(ResultSet.class);
        when(row.getLong(1)).thenReturn(5L);when(row.getString(2)).thenReturn("原文档");when(row.getString(3)).thenReturn(ASSOCIATION);
        var jdbc=mock(JdbcTemplate.class,invocation->{
            assertEquals("query",invocation.getMethod().getName());
            String sql=invocation.getArgument(0);
            String normalized=sql.replaceAll("\\s+"," ").trim().toLowerCase(Locale.ROOT);
            assertTrue(normalized.startsWith("select d.id,d.title,pd.association_id from document d "));
            assertTrue(normalized.contains("c.doc_id=d.id and c.user_id=?"));
            assertTrue(normalized.contains("pd.project_id=? and pd.doc_id=d.id"));
            assertTrue(normalized.contains("d.id=? and d.is_deleted=0 and (d.owner_id=? or c.permission in(1,2))"));
            assertFalse(normalized.contains("content"));assertFalse(normalized.contains("for update"));
            assertFalse(normalized.contains("limit"));assertFalse(normalized.contains("locate"));
            assertEquals(2L,(long)invocation.getArgument(2));assertEquals(10L,(long)invocation.getArgument(3));
            assertEquals(5L,(long)invocation.getArgument(4));assertEquals(2L,(long)invocation.getArgument(5));
            RowMapper<?> mapper=invocation.getArgument(1);return List.of(mapper.mapRow(row,0));
        });
        assertEquals(new ProjectRepository.AssociationState(5,"原文档",ASSOCIATION),
            new ProjectRepository(jdbc).findVisibleAssociationState(10,5,2).orElseThrow());
        verify(row).getLong(1);verify(row).getString(2);verify(row).getString(3);verifyNoMoreInteractions(row);
    }

    @Test void aVisibleDocumentWithoutAssociationHasANullIdentifier() throws Exception {
        var row=mock(ResultSet.class);
        when(row.getLong(1)).thenReturn(5L);when(row.getString(2)).thenReturn("原文档");
        var jdbc=mock(JdbcTemplate.class,invocation->{
            assertEquals("query",invocation.getMethod().getName());
            RowMapper<?> mapper=invocation.getArgument(1);return List.of(mapper.mapRow(row,0));
        });
        var current=new ProjectRepository(jdbc).findVisibleAssociationState(10,5,2).orElseThrow();
        assertEquals(5,current.docId());assertEquals("原文档",current.docTitle());assertNull(current.associationId());
    }

    @Test void noVisibleDocumentDoesNotBecomeAFalseUnlinkedResult() {
        var jdbc=mock(JdbcTemplate.class,invocation->{assertEquals("query",invocation.getMethod().getName());return List.of();});
        assertTrue(new ProjectRepository(jdbc).findVisibleAssociationState(10,5,2).isEmpty());
    }

    @Test void projectStateSourceReadsOnlyAuthorizationAndMetadataWithoutALock() throws Exception {
        var row=mock(ResultSet.class);
        when(row.getLong(1)).thenReturn(10L);when(row.getString(2)).thenReturn("项目");when(row.getString(3)).thenReturn("简介");
        when(row.getLong(4)).thenReturn(2L);when(row.getLong(5)).thenReturn(0L);when(row.getBoolean(6)).thenReturn(true);
        var jdbc=mock(JdbcTemplate.class,invocation->{
            assertEquals("query",invocation.getMethod().getName());
            assertEquals("SELECT id,name,description,owner_id,group_id,is_archived FROM copage_project WHERE id=?",invocation.getArgument(0));
            assertEquals(10L,(long)invocation.getArgument(2));
            RowMapper<?> mapper=invocation.getArgument(1);return List.of(mapper.mapRow(row,0));
        });
        assertEquals(new ProjectRepository.Project(10,"项目","简介",2,0,true),new ProjectRepository(jdbc).find(10,false).orElseThrow());
    }
}
