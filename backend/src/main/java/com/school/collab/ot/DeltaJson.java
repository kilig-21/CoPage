package com.school.collab.ot;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.nio.charset.StandardCharsets;

/** Shared JSON representation for persisted Quill Deltas. Callers own absent-value policy. */
public final class DeltaJson {
    private DeltaJson() { }

    public static Delta read(ObjectMapper mapper, String json, String failureMessage) {
        try {
            return mapper.readValue(json, Delta.class);
        } catch (JsonProcessingException failure) {
            throw new IllegalStateException(failureMessage, failure);
        }
    }

    public static String write(ObjectMapper mapper, Delta delta, String failureMessage) {
        try {
            return mapper.writeValueAsString(delta);
        } catch (JsonProcessingException failure) {
            throw new IllegalStateException(failureMessage, failure);
        }
    }

    public static int utf8Bytes(ObjectMapper mapper, Delta delta) {
        return write(mapper, delta, "无法序列化 Delta").getBytes(StandardCharsets.UTF_8).length;
    }

    /** Only text inserts become searchable content; embeds and attributes are excluded. */
    public static String plainText(ObjectMapper mapper, String json) {
        if (json == null) return "";
        try {
            JsonNode root = mapper.readTree(json);
            var text = new StringBuilder();
            for (JsonNode op : root.path("ops")) {
                JsonNode insert = op.path("insert");
                if (insert.isTextual()) text.append(insert.asText());
            }
            return text.toString();
        } catch (Exception failure) {
            throw new IllegalStateException("文档 Delta 内容无法索引", failure);
        }
    }
}
