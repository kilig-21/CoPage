package com.school.collab.document;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.common.BizException;
import com.school.collab.common.ErrorCode;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockMultipartFile;

import java.nio.charset.StandardCharsets;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class DocumentTransferTest {
    private final DocumentService docs = mock(DocumentService.class);
    private final ObjectMapper mapper = new ObjectMapper();
    private final DocumentTransfer transfer = new DocumentTransfer(docs, mapper);
    private MockMultipartFile file(String name, String text) { return new MockMultipartFile("file", name, "application/octet-stream", text.getBytes(StandardCharsets.UTF_8)); }

    @Test
    void utf8TextNormalizesBomAndLineEndingsWithoutParsingHtml() throws Exception {
        transfer.importFile(file("会议.txt", "\uFEFF<h1>你好</h1>\r\n第二行\r第三行"), null);
        verify(docs).createImported("会议", mapper.readTree("{\"ops\":[{\"insert\":\"<h1>你好</h1>\\n第二行\\n第三行\\n\"}]}"));
    }

    @Test
    void malformedOversizedAndNonCopyJsonNeverCreateDocuments() {
        for (var input : new MockMultipartFile[]{file("bad.json", "{}"), file("bad.json", "{broken"), file("a.html", "<p>text</p>"),
                new MockMultipartFile("file", "a.txt", "text/plain", new byte[]{(byte)0xC3}), file("a.txt", ""),
                new MockMultipartFile("file", "a.txt", "text/plain", new byte[DocumentTransfer.MAX_BYTES + 1])}) {
            assertEquals(ErrorCode.PARAM_ERROR, assertThrows(BizException.class, () -> transfer.importFile(input, null)).getErrorCode());
        }
        verifyNoInteractions(docs);
    }

    @Test
    void portableRichContentPreservesAttributesButRejectsOperationsAndExecutableUrls() throws Exception {
        var rich = mapper.readTree("{\"ops\":[{\"insert\":\"中文\",\"attributes\":{\"bold\":true}},{\"insert\":{\"image\":\"http://localhost:9000/collab/image.png\"}},{\"insert\":\"\\n\",\"attributes\":{\"header\":1}}]}");
        assertEquals(rich, transfer.validateContent(rich));
        for (String invalid : new String[]{"{\"ops\":[{\"retain\":1}]}", "{\"ops\":[{\"insert\":\"x\\n\",\"attributes\":{\"link\":\"javascript:alert(1)\"}}]}",
                "{\"ops\":[{\"insert\":{\"image\":\"data:image/svg+xml,payload\"}},{\"insert\":\"\\n\"}]}",
                "{\"ops\":[{\"insert\":\"x\\n\",\"attributes\":{\"header\":\"1\"}}]}", "{\"ops\":[{\"insert\":\"no-final-newline\"}]}",
                "{\"ops\":[{\"insert\":\"x\\n\",\"delete\":1}]}", "{\"ops\":[{\"insert\":\"x\\n\",\"attributes\":{\"unknown\":true}}]}"}) {
            var parsed = mapper.readTree(invalid);
            assertThrows(BizException.class, () -> transfer.validateContent(parsed));
        }
        var copy = mapper.createObjectNode().put("format", "copage").put("version", 1).put("title", "富文本"); copy.set("content", rich);
        transfer.importFile(file("copy.json", copy.toString()), null);
        verify(docs).createImported("富文本", rich);
        assertThrows(BizException.class, () -> transfer.importFile(file("copy.json", copy + " {}"), null));
    }

    @Test
    void exportUsesAuthorizedSnapshotAndCopiesNoIdentityOrHistory() throws Exception {
        var content = mapper.readTree("{\"ops\":[{\"insert\":\"正文\\n\"}]}");
        when(docs.detail(5)).thenReturn(new DocumentService.DetailView(5,"会议/记录",content,8,1,1,"2026-10-03 20:00:00",false));
        var exported = transfer.export(5,"copage");
        assertEquals("会议_记录.copage.json", exported.filename());
        assertEquals(8, exported.revision());
        var copy = mapper.readTree(exported.content());
        assertEquals(4, copy.size()); assertEquals(content, copy.path("content")); assertFalse(copy.has("ownerId"));
        assertEquals("正文\n", transfer.export(5,"txt").content());
        assertThrows(BizException.class, () -> transfer.export(5,"unsupported"));
        when(docs.detail(6)).thenThrow(new BizException(ErrorCode.FORBIDDEN));
        assertEquals(ErrorCode.FORBIDDEN, assertThrows(BizException.class, () -> transfer.export(6,"txt")).getErrorCode());
    }

    @Test
    void fragmentedTextNormalizesWithoutChangingFormatOrFinalNewline() {
        var ops = mapper.createArrayNode();
        for (int i = 0; i < 1000; i++) ops.add(mapper.createObjectNode().put("insert", "片段"));
        ops.add(mapper.createObjectNode().put("insert", "\n"));
        var normalized = transfer.validateContent(mapper.createObjectNode().set("ops", ops));
        assertEquals(1, normalized.path("ops").size());
        assertEquals("片段".repeat(1000) + "\n", normalized.path("ops").get(0).path("insert").asText());
    }

    @Test
    void savedDocumentAtCapacityExportsAndImportsWithoutLosingEnvelopeOrRichContent() throws Exception {
        String prefix = "中文😀\\\"\n".repeat(1000);
        var first = mapper.createObjectNode().put("insert", prefix);
        first.set("attributes", mapper.createObjectNode().put("bold", true));
        var image = mapper.createObjectNode().set("insert", mapper.createObjectNode().put("image", "https://example.invalid/backup.png"));
        var ops = mapper.createArrayNode().add(first).add(image).add(mapper.createObjectNode().put("insert", "\n"));
        var content = mapper.createObjectNode().set("ops", ops);
        int padding = 2 * 1024 * 1024 - content.toString().getBytes(StandardCharsets.UTF_8).length;
        first.put("insert", prefix + "a".repeat(padding));
        assertEquals(2 * 1024 * 1024, content.toString().getBytes(StandardCharsets.UTF_8).length);
        String title = "标题".repeat(100);
        when(docs.detail(17)).thenReturn(new DocumentService.DetailView(17,title,content,9,1,1,"2026-10-13 20:00:00",false));
        var copy = transfer.export(17,"copage");
        assertTrue(copy.content().getBytes(StandardCharsets.UTF_8).length > 2 * 1024 * 1024);
        assertEquals(9,copy.revision());
        assertEquals(content,mapper.readTree(copy.content()).path("content"));
        transfer.importFile(file(copy.filename(),copy.content()),null);
        verify(docs).createImported(title,content);
        String padded=copy.content()+" ".repeat(DocumentTransfer.MAX_BYTES-copy.content().getBytes(StandardCharsets.UTF_8).length);
        assertEquals(3*1024*1024,padded.getBytes(StandardCharsets.UTF_8).length);
        transfer.importFile(file(copy.filename(),padded),null);
        verify(docs,times(2)).createImported(title,content);
        assertEquals(first.path("insert").asText()+"[图片：https://example.invalid/backup.png]\n",transfer.export(17,"txt").content());
    }

    @Test
    void importRejectsBodyExpansionBeyondEditorCapacityBeforeCreating() {
        // 文件小于2MiB，但反斜线JSON转义会让实际正文超过2MiB。
        assertEquals(ErrorCode.PARAM_ERROR,assertThrows(BizException.class,()->
                transfer.importFile(file("escaped.txt","\\".repeat(1024 * 1024)),null)).getErrorCode());
        verifyNoInteractions(docs);
    }

    @Test
    void exportPreservesStoredFragmentsWithoutApplyingImportNormalizationLimit() throws Exception {
        var ops=mapper.createArrayNode();
        for(int i=0;i<10001;i++) {
            var op=mapper.createObjectNode().put("insert","段");
            op.set("attributes",mapper.createObjectNode().put("bold",i%2==0));
            ops.add(op);
        }
        ops.add(mapper.createObjectNode().put("insert","\n"));
        var content=mapper.createObjectNode().set("ops",ops);
        when(docs.detail(18)).thenReturn(new DocumentService.DetailView(18,"已保存片段",content,2,1,1,"2026-10-13 20:00:00",false));
        assertEquals(content,mapper.readTree(transfer.export(18,"copage").content()).path("content"));
        // 导入片段上限继续保留，下载不能为满足导入限制截断已有正文。
        assertTrue(assertThrows(BizException.class,()->transfer.importFile(file("many.json",transfer.export(18,"copage").content()),null))
                .getMessage().contains("10000"));
        var boundary=mapper.createArrayNode();
        for(int i=0;i<9999;i++)boundary.add(ops.get(i));
        boundary.add(mapper.createObjectNode().put("insert","\n"));
        var accepted=mapper.createObjectNode().set("ops",boundary);
        assertEquals(10000,transfer.validateContent(accepted).path("ops").size());
    }
}
