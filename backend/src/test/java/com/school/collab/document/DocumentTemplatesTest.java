package com.school.collab.document;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class DocumentTemplatesTest {
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
