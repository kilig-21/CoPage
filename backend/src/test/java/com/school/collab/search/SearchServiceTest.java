package com.school.collab.search;

import com.school.collab.common.UserContext;
import com.school.collab.document.DocumentRepository;
import com.school.collab.document.DocumentRepository.DocumentRow;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class SearchServiceTest {
    private final SearchIndex index = mock(SearchIndex.class);
    private final DocumentRepository documents = mock(DocumentRepository.class);
    private final SearchService service = new SearchService(index, documents);

    @AfterEach
    void clear() {
        UserContext.clear();
    }

    @Test
    void Unicode大小写转换不能改变原文高亮坐标() {
        assertEquals("İ <strong>TARGET</strong>", SearchService.highlight("İ TARGET", "target"));
        UserContext.set(1L, "owner");
        when(documents.visibleIds(1)).thenReturn(List.of(5L));
        when(index.search("target", List.of(5L), 1, 20))
                .thenReturn(new SearchIndex.SearchPage(1, List.of(5L)));
        when(documents.find(5L)).thenReturn(Optional.of(new DocumentRow(
                5, "标题", "{\"ops\":[{\"insert\":\"İ TARGET\\n\"}]}", 1,
                1, "owner", 0, LocalDateTime.now())));
        assertEquals("İ <strong>TARGET</strong>\n", service.search("target", 1, 20).list().getFirst().snippet());
        assertEquals("<strong>i</strong>", SearchService.highlight("i", "İ"));
    }

    @Test
    void 摘要窗口不能拆开UTF16代理对() {
        assertEquals("a".repeat(159) + "😀", SearchService.highlight("a".repeat(159) + "😀末", "missing"));
        assertEquals("…😀" + "b".repeat(59) + "<strong>TARGET</strong>",
                SearchService.highlight("a😀" + "b".repeat(59) + "TARGET", "target"));
        assertEquals("<strong>TARGET</strong>" + "a".repeat(79) + "😀…",
                SearchService.highlight("TARGET" + "a".repeat(79) + "😀末", "target"));
    }

    @Test
    void Unicode高亮仍按字面关键词并转义原文HTML() {
        assertEquals("&lt;b&gt;İ <strong>[x].*</strong>&lt;/b&gt;",
                SearchService.highlight("<b>İ [x].*</b>", "[x].*"));
        assertEquals("<strong>a\\E</strong>", SearchService.highlight("a\\E", "a\\E"));
        assertEquals("<strong>Σ</strong>", SearchService.highlight("Σ", "ς"));
    }

    @Test
    void 检索只交给ES当前用户可见的文档ID() {
        UserContext.set(1L, "owner");
        when(documents.visibleIds(1)).thenReturn(List.of(5L));
        when(index.search("协同", List.of(5L), 1, 20))
                .thenReturn(new SearchIndex.SearchPage(1, List.of(5L)));
        when(documents.find(5L)).thenReturn(Optional.of(new DocumentRow(
                5, "需求", "{\"ops\":[{\"insert\":\"安全协同\\n\"}]}", 1,
                1, "owner", 0, LocalDateTime.of(2026, 9, 26, 20, 0))));

        SearchService.SearchView result = service.search("协同", 1, 20);

        verify(documents).visibleIds(1);
        assertEquals(1, result.total());
        assertEquals("安全<strong>协同</strong>\n", result.list().getFirst().snippet());
    }

    @Test
    void 摘要中的原始HTML应被转义() {
        String highlighted = SearchService.highlight("<img src=x>协同", "协同");
        assertTrue(highlighted.contains("&lt;img src=x&gt;"));
        assertTrue(highlighted.contains("<strong>协同</strong>"));
        assertFalse(highlighted.contains("<img"));
    }

    @Test
    void Delta索引只提取文本不索引图片地址() {
        String delta = "{\"ops\":[{\"insert\":\"正文\"},"
                + "{\"insert\":{\"image\":\"https://secret.example/a.png\"}},"
                + "{\"insert\":\"\\n\"}]}";
        assertEquals("正文\n", SearchIndex.plainText(delta));
    }

    @Test
    void ES返回旧候选时仍剔除已撤权和已删除文档() {
        UserContext.set(2L, "formerMember");
        when(documents.visibleIds(2)).thenReturn(List.of(5L, 6L));
        when(index.search("正文", List.of(5L, 6L), 1, 20))
                .thenReturn(new SearchIndex.SearchPage(2, List.of(5L, 6L)));
        when(documents.find(5L)).thenReturn(Optional.of(new DocumentRow(
                5, "旧标题", "{\"ops\":[{\"insert\":\"正文\\n\"}]}", 1,
                1, "owner", 0, LocalDateTime.now())));
        when(documents.collaboratorPermission(5L, 2L)).thenReturn(0);
        when(documents.find(6L)).thenReturn(Optional.empty());
        assertTrue(service.search("正文", 1, 20).list().isEmpty());
    }
}
