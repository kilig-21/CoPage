package com.school.collab.ot;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class DeltaJsonTest {
    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void 应按Quill格式序列化并能往返解析() throws Exception {
        Map<String, Object> removeBold = new LinkedHashMap<>();
        removeBold.put("bold", null);
        Delta source = new Delta().retain(1, removeBold).insert("A");

        String json = mapper.writeValueAsString(source);
        Delta parsed = mapper.readValue(json, Delta.class);

        assertTrue(json.contains("\"retain\":1"));
        assertTrue(json.contains("\"bold\":null"));
        assertEquals(source.getOps(), parsed.getOps());
    }

    @Test
    void 非法零长度操作不能进入内核() {
        assertThrows(Exception.class, () ->
                mapper.readValue("{\"ops\":[{\"retain\":0}]}", Delta.class));
        assertThrows(Exception.class, () ->
                mapper.readValue("{\"ops\":[{\"insert\":\"\"}]}", Delta.class));
        assertThrows(Exception.class, () ->
                mapper.readValue("{\"ops\":[{\"insert\":{}}]}", Delta.class));
    }

    @Test
    void persistedFormatPreservesUtf8TextEmbedsAndAttributes() throws Exception {
        var delta = new Delta().push(Op.insert("中文🙂", Map.of("bold", true)))
                .push(Op.insertEmbed(mapper.createObjectNode().put("image", "/api/images/example")))
                .insert("\n");
        String json = DeltaJson.write(mapper, delta, "serialization failed");

        assertEquals(mapper.writeValueAsString(delta), json);
        assertEquals(delta.getOps(), DeltaJson.read(mapper, json, "read failed").getOps());
        assertEquals(json.getBytes(StandardCharsets.UTF_8).length, DeltaJson.utf8Bytes(mapper, delta));
        assertEquals("中文🙂\n", DeltaJson.plainText(mapper, json));
    }

    @Test
    void malformedPersistenceReportsTheCallersFailureCategory() {
        var failure = assertThrows(IllegalStateException.class,
                () -> DeltaJson.read(mapper, "{", "历史版本内容损坏"));
        assertEquals("历史版本内容损坏", failure.getMessage());
        assertNotNull(failure.getCause());
        assertNull(DeltaJson.read(mapper, "null", "read failed"));
    }
}
