package com.school.collab.ot;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.assertThrows;

class DeltaJsonTest {

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Test
    void 应按Quill格式序列化并能往返解析() throws Exception {
        Map<String, Object> removeBold = new LinkedHashMap<>();
        removeBold.put("bold", null);
        Delta source = new Delta().retain(1, removeBold).insert("A");

        String json = objectMapper.writeValueAsString(source);
        Delta parsed = objectMapper.readValue(json, Delta.class);

        assertTrue(json.contains("\"retain\":1"));
        assertTrue(json.contains("\"bold\":null"));
        assertEquals(source.getOps(), parsed.getOps());
    }

    @Test
    void 非法零长度操作不能进入内核() {
        assertThrows(Exception.class, () ->
                objectMapper.readValue("{\"ops\":[{\"retain\":0}]}", Delta.class));
        assertThrows(Exception.class, () ->
                objectMapper.readValue("{\"ops\":[{\"insert\":\"\"}]}", Delta.class));
        assertThrows(Exception.class, () ->
                objectMapper.readValue("{\"ops\":[{\"insert\":{}}]}", Delta.class));
    }
}
