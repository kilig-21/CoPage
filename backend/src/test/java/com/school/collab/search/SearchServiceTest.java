package com.school.collab.search;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.common.UserContext;
import com.school.collab.document.DocumentRepository;
import com.school.collab.document.DocumentRepository.DocumentRow;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;
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

    private void candidate(String query, String title, String delta) {
        UserContext.set(1L, "owner");
        when(documents.visibleIds(1)).thenReturn(List.of(5L));
        when(index.search(query, List.of(5L), 1, 20)).thenReturn(new SearchIndex.SearchPage(1, List.of(5L)));
        when(documents.find(5L)).thenReturn(Optional.of(new DocumentRow(
                5, title, delta, 1, 1, "owner", 0, LocalDateTime.of(2026, 10, 16, 9, 0))));
    }

    private static String delta(String text) throws Exception {
        return new ObjectMapper().writeValueAsString(Map.of("ops", List.of(Map.of("insert", text))));
    }

    @AfterEach
    void clear() {
        UserContext.clear();
    }

    @Test
    void 标题命中而正文未命中时展示当前正文开头而非重复标题() {
        UserContext.set(1L, "owner");
        when(documents.visibleIds(1)).thenReturn(List.of(5L));
        when(index.search("人工验收", List.of(5L), 1, 20))
                .thenReturn(new SearchIndex.SearchPage(1, List.of(5L)));
        when(documents.find(5L)).thenReturn(Optional.of(new DocumentRow(
                5, "人工验收-合成资料", "{\"ops\":[{\"insert\":\"这份资料记录本周排期和负责人。\\n\"}]}", 1,
                1, "owner", 0, LocalDateTime.of(2026, 10, 16, 9, 0))));

        var hit = service.search("人工验收", 1, 20).list().getFirst();
        assertEquals("这份资料记录本周排期和负责人。", hit.snippet());
        assertEquals("人工验收-合成资料", hit.title());
        assertEquals("2026-10-16 09:00:00", hit.updateTime());
    }

    @Test
    void 标题和正文都命中时仍展示正文原上下文并高亮() throws Exception {
        candidate("需求", "需求周报", delta("项目启动后需要同步需求与负责人。\n"));
        assertEquals("项目启动后需要同步<strong>需求</strong>与负责人。\n",
                service.search("需求", 1, 20).list().getFirst().snippet());
    }

    @Test
    void 正文开头略过空行并保留跨富文本片段的多语文字() throws Exception {
        String text = "Résumé 项目 — Συντονισμός 日本語 مرحبا";
        String rich = new ObjectMapper().writeValueAsString(Map.of("ops", List.of(
                Map.of("insert", "\n\t \u00a0\u2003"),
                Map.of("insert", "Résumé 项目 — ", "attributes", Map.of("bold", true)),
                Map.of("insert", "Συντονισμός 日本語 مرحبا", "attributes", Map.of("link", "https://private.example/details")),
                Map.of("insert", Map.of("image", "https://private.example/image.png")), Map.of("insert", "\n"))));
        candidate("验收", "验收记录", rich);
        assertEquals(text, service.search("验收", 1, 20).list().getFirst().snippet());
    }

    @Test
    void 空白或图片正文只提示暂无文字而不声称没有正文() throws Exception {
        for (String body : new String[]{null, "{\"ops\":[]}", delta("\n\t\r \u00a0\u2003\u2007\u202f"),
                "{\"ops\":[{\"insert\":{\"image\":\"https://private.example/image.png\"}},{\"insert\":\"\\n\"}]}"}) {
            candidate("报告", "报告说明", body);
            assertEquals("标题匹配，暂无文字摘要", service.search("报告", 1, 20).list().getFirst().snippet());
        }
    }

    @Test
    void ES词项命中或旧索引不代表当前标题存在完整字面关键词() throws Exception {
        candidate("alpha beta", "当前标题", delta("\n"));
        assertEquals("暂无文字摘要", service.search("alpha beta", 1, 20).list().getFirst().snippet());
        candidate("alpha beta", "当前标题", delta("目前记录了 alpha 方案及后续事项。\n"));
        assertEquals("目前记录了 alpha 方案及后续事项。", service.search("alpha beta", 1, 20).list().getFirst().snippet());
    }

    @Test
    void 正文开头中的HTML和原strong必须转义而不能成为高亮或元素() throws Exception {
        candidate("验收", "验收记录", delta("<img src=x onerror=alert(1)> & <strong>原文</strong> \"引号\" '单引号'\n"));
        assertEquals("&lt;img src=x onerror=alert(1)&gt; &amp; &lt;strong&gt;原文&lt;/strong&gt; &quot;引号&quot; &#39;单引号&#39;",
                service.search("验收", 1, 20).list().getFirst().snippet());
    }

    @Test
    void 开头摘要限制长度标明省略且不切开emoji代理对() throws Exception {
        candidate("验收", "验收记录", delta("a".repeat(159) + "😀末\n"));
        assertEquals("a".repeat(159) + "😀…", service.search("验收", 1, 20).list().getFirst().snippet());
        candidate("验收", "验收记录", delta("a".repeat(160) + "\n"));
        assertEquals("a".repeat(160), service.search("验收", 1, 20).list().getFirst().snippet());
    }

    @Test
    void 当前只读协作者可以获得已授权正文摘要() throws Exception {
        UserContext.set(2L, "reader");
        when(documents.visibleIds(2)).thenReturn(List.of(5L));
        when(index.search("验收", List.of(5L), 1, 20)).thenReturn(new SearchIndex.SearchPage(1, List.of(5L)));
        when(documents.find(5L)).thenReturn(Optional.of(new DocumentRow(
                5, "验收记录", delta("当前已保存的工作安排。\n"), 1, 1, "owner", 0, LocalDateTime.now())));
        when(documents.collaboratorPermission(5L, 2L)).thenReturn(1);
        assertEquals("当前已保存的工作安排。", service.search("验收", 1, 20).list().getFirst().snippet());
        verify(documents).collaboratorPermission(5L, 2L);
    }

    @Test
    void 标题候选被撤权或删除后不生成正文摘要也不解析其内容() {
        UserContext.set(2L, "formerReader");
        when(documents.visibleIds(2)).thenReturn(List.of(5L, 6L));
        when(index.search("验收", List.of(5L, 6L), 1, 20)).thenReturn(new SearchIndex.SearchPage(2, List.of(5L, 6L)));
        // 若在二次权限检查前提取内容，此无效Delta会使整次请求失败。
        when(documents.find(5L)).thenReturn(Optional.of(new DocumentRow(
                5, "验收记录", "unreadable-delta", 1, 1, "owner", 0, LocalDateTime.now())));
        when(documents.collaboratorPermission(5L, 2L)).thenReturn(0);
        when(documents.find(6L)).thenReturn(Optional.empty());
        assertTrue(service.search("验收", 1, 20).list().isEmpty());
        verify(documents).collaboratorPermission(5L, 2L);
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
