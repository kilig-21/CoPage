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
}
