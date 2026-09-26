package com.school.collab.collab.persist;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.school.collab.ot.Delta;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.TreeMap;

/** 对原始请求（而非 OT 变换后的操作）生成稳定指纹，防止误复用 opId 吞掉编辑。 */
public final class OperationFingerprint {
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private OperationFingerprint() {
    }

    public static String of(long baseRevision, Delta operation) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            digest.update(Long.toString(baseRevision).getBytes(StandardCharsets.UTF_8));
            digest.update((byte) ':');
            digest.update(MAPPER.writeValueAsBytes(canonical(MAPPER.valueToTree(operation))));
            return HexFormat.of().formatHex(digest.digest());
        } catch (NoSuchAlgorithmException | JsonProcessingException exception) {
            throw new IllegalStateException("无法计算协同操作指纹", exception);
        }
    }

    private static JsonNode canonical(JsonNode node) {
        if (node.isObject()) {
            ObjectNode sorted = MAPPER.createObjectNode();
            TreeMap<String, JsonNode> fields = new TreeMap<>();
            node.fields().forEachRemaining(entry -> fields.put(entry.getKey(), entry.getValue()));
            fields.forEach((key, value) -> sorted.set(key, canonical(value)));
            return sorted;
        }
        if (node.isArray()) {
            ArrayNode values = MAPPER.createArrayNode();
            node.forEach(value -> values.add(canonical(value)));
            return values;
        }
        return node.deepCopy();
    }
}
