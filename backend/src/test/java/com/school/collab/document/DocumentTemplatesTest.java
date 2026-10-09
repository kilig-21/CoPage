package com.school.collab.document;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class DocumentTemplatesTest {
    @Test
    void allPublicTemplatesAreValidInitialDocumentsWithUniqueIds() {
        var templates=DocumentTemplates.list();
        assertEquals(templates.size(),templates.stream().map(DocumentTemplates.TemplateView::id).distinct().count());
        var mapper=new com.fasterxml.jackson.databind.ObjectMapper();
        for(var template:templates) {
            assertTrue(java.util.Set.of("collaboration","planning","learning").contains(template.category()));
            var content=mapper.<com.fasterxml.jackson.databind.JsonNode>valueToTree(template.content());
            assertDoesNotThrow(()->DocumentFormats.validateEditorOperation(content));
            var ops=content.path("ops");
            assertTrue(ops.get(ops.size()-1).path("insert").asText().endsWith("\n"));
            assertTrue(template.title().length()<=200);
        }
        assertEquals(com.school.collab.common.ErrorCode.PARAM_ERROR,
            assertThrows(com.school.collab.common.BizException.class,()->DocumentTemplates.require("missing")).getErrorCode());
    }
    @Test
    void editingOneTemplateDoesNotChangeNextCreation() {
        var first = DocumentTemplates.require("meeting").content();
        var original = DocumentTemplates.require("meeting").content().copy();
        first.insert("用户修改");
        var mapper = new com.fasterxml.jackson.databind.ObjectMapper();
        assertEquals(mapper.valueToTree(original), mapper.valueToTree(DocumentTemplates.require("meeting").content()));
        assertNotEquals(mapper.valueToTree(original), mapper.valueToTree(first));
    }
}
