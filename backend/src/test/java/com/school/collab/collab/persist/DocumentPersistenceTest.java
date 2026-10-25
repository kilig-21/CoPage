package com.school.collab.collab.persist;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.collab.CollabException;
import com.school.collab.ot.Delta;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class DocumentPersistenceTest {
    private final JdbcTemplate jdbc = mock(JdbcTemplate.class);
    private final DocumentPersistence persistence = new DocumentPersistence(jdbc, new ObjectMapper());
    private final Delta content = new Delta().insert("已保存正文\n");
    private final Delta operation = new Delta().insert("已保存正文");

    @Test
    void 预检沿用真实序列化UTF8容量且不读写数据库() {
        assertDoesNotThrow(() -> persistence.validateSize(
                new Delta().insert("a".repeat(2_000_000) + "\n"),
                new Delta().insert("b".repeat(4_000_000))));
        assertEquals(400, assertThrows(CollabException.class, () -> persistence.validateSize(
                new Delta().insert("文".repeat(700_000) + "\n"), operation)).getCode());
        assertEquals(400, assertThrows(CollabException.class, () -> persistence.validateSize(
                content, new Delta().insert("x".repeat(4 * 1024 * 1024)))).getCode());
        // Escaped control characters consume their actual JSON bytes too.
        assertEquals(400, assertThrows(CollabException.class, () -> persistence.validateSize(
                new Delta().insert("\0".repeat(400_000) + "\n"), operation)).getCode());
        verifyNoInteractions(jdbc);
    }

    private void document(long owner) {
        doReturn(List.of(owner)).when(jdbc).query(contains("FROM document"), any(RowMapper.class), eq(7L));
        doReturn(1).when(jdbc).update(contains("UPDATE document SET content"), anyString(), eq(7L), eq(0L));
    }

    private void permission(Integer permission) {
        doReturn(permission == null ? List.of() : List.of(permission)).when(jdbc).query(
                contains("FROM doc_collaborator"), any(RowMapper.class), eq(7L), eq(2L));
    }

    @Test
    void 降为只读后持久化拒绝正文日志和收据写入() {
        document(1); permission(1);
        var failure = assertThrows(CollabException.class, () ->
                persistence.persist(7, 0, content, operation, 2L, "client", "op", "hash"));
        assertEquals(403, failure.getCode());
        verify(jdbc, never()).update(anyString(), any(Object[].class));
    }

    @Test
    void 撤权后无收据版本的持久化也必须拒绝() {
        document(1); permission(null);
        var failure = assertThrows(CollabException.class, () -> persistence.persist(7, 0, content, operation, 2L));
        assertEquals(403, failure.getCode());
        verify(jdbc, never()).update(anyString(), any(Object[].class));
    }

    @Test
    void 文档已经删除时不允许写入正文或收据() {
        document(1);
        doReturn(List.of()).when(jdbc).query(contains("FROM document"), any(RowMapper.class), eq(7L));
        assertEquals(404, assertThrows(CollabException.class, () ->
                persistence.persist(7, 0, content, operation, 2L, "client", "op", "hash")).getCode());
        verify(jdbc, never()).update(anyString(), any(Object[].class));
        verify(jdbc, never()).query(contains("FROM doc_collaborator"), any(RowMapper.class), anyLong(), anyLong());
    }

    @Test
    void 编辑成员先锁当前文档和权限再按原顺序写入正文日志收据() {
        document(1); permission(2);
        persistence.persist(7, 0, content, operation, 2L, "client", "op", "hash");
        var order = inOrder(jdbc);
        order.verify(jdbc).query(argThat(sql -> sql.contains("FROM document") && sql.contains("is_deleted = 0") && sql.contains("FOR UPDATE")),
                any(RowMapper.class), eq(7L));
        order.verify(jdbc).query(argThat(sql -> sql.contains("FROM doc_collaborator") && sql.contains("FOR UPDATE")),
                any(RowMapper.class), eq(7L), eq(2L));
        order.verify(jdbc).update(contains("UPDATE document SET content"), anyString(), eq(7L), eq(0L));
        order.verify(jdbc).update(contains("INSERT INTO doc_operation "), eq(7L), eq(1L), anyString(), eq(2L));
        order.verify(jdbc).update(contains("INSERT INTO doc_operation_receipt"), eq(7L), eq(2L), eq("client"), eq("op"), eq(1L), eq("hash"));
        order.verifyNoMoreInteractions();
    }

    @Test
    void 所有者恢复历史无需协作者成员行仍保留原收据身份() {
        document(2);
        persistence.persist(7, 0, content, operation, 2L, "history-api", "restore-request", "hash");
        verify(jdbc).query(contains("FOR UPDATE"), any(RowMapper.class), eq(7L));
        verify(jdbc, never()).query(contains("FROM doc_collaborator"), any(RowMapper.class), anyLong(), anyLong());
        verify(jdbc).update(contains("INSERT INTO doc_operation_receipt"), eq(7L), eq(2L),
                eq("history-api"), eq("restore-request"), eq(1L), eq("hash"));
    }

    @Test
    void 旧缓存补持久化的无用户内部路径继续使用原CAS而不伪造成员权限() {
        document(1);
        persistence.persist(7, 0, content, operation, null);
        verify(jdbc, never()).query(anyString(), any(RowMapper.class), any(Object[].class));
        verify(jdbc).update(contains("UPDATE document SET content"), anyString(), eq(7L), eq(0L));
        verify(jdbc).update(contains("INSERT INTO doc_operation "), eq(7L), eq(1L), anyString(), isNull());
        verify(jdbc, never()).update(contains("INSERT INTO doc_operation_receipt"), any(Object[].class));
    }

    @Test
    void CAS版本冲突不追加操作日志或收据() {
        document(2);
        doReturn(0).when(jdbc).update(contains("UPDATE document SET content"), anyString(), eq(7L), eq(0L));
        assertEquals(40902, assertThrows(CollabException.class, () ->
                persistence.persist(7, 0, content, operation, 2L, "client", "op", "hash")).getCode());
        verify(jdbc, never()).update(contains("INSERT INTO doc_operation "), any(Object[].class));
        verify(jdbc, never()).update(contains("INSERT INTO doc_operation_receipt"), any(Object[].class));
    }
}
