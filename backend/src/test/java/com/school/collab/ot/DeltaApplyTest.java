package com.school.collab.ot;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.Map;
import java.time.Duration;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTimeout;

class DeltaApplyTest {

    @Test
    void 大量细粒度修改应线性聚合正文而不反复复制累计字符串() {
        int repetitions = 50_000;
        Delta document = new Delta().insert("abcd".repeat(repetitions) + "\n");
        Delta change = new Delta();
        for (int i = 0; i < repetitions; i++) change.retain(3).delete(1).insert("e");
        var original = document.getOps();
        var operations = change.getOps();
        assertTimeout(Duration.ofSeconds(5), () -> {
            Delta applied = DeltaApply.apply(document, change);
            assertEquals(new Delta().insert("abce".repeat(repetitions) + "\n").getOps(), applied.getOps());
        });
        assertEquals(original, document.getOps());
        assertEquals(operations, change.getOps());
    }

    @Test
    void 文本聚合仍应保留格式边界嵌入旧null以及未覆盖尾部() {
        var image = new ObjectMapper().createObjectNode().put("image", "https://example.test/b.png");
        Map<String, Object> legacy = new LinkedHashMap<>();
        legacy.put("legacy", null);
        Delta document = new Delta().insert("ab", Map.of("bold", true))
                .push(Op.insertEmbed(image, Map.of("width", "10")))
                .insert("cd", legacy).insert("\n");
        var original = document.getOps();
        Delta change = new Delta().retain(1).insert("X", Map.of("bold", true))
                .retain(2).insert("Y", legacy);
        Delta expected = new Delta().insert("aXb", Map.of("bold", true))
                .push(Op.insertEmbed(image, Map.of("width", "10")))
                .insert("Ycd", legacy).insert("\n");
        assertEquals(expected.getOps(), DeltaApply.apply(document, change).getOps());
        assertEquals(original, document.getOps());
    }

    @Test
    void 应插入文本并保留未覆盖的尾部内容() {
        Delta document = new Delta().insert("Hello\n");
        Delta change = new Delta().retain(5).insert(" world");

        Delta applied = DeltaApply.apply(document, change);

        assertEquals("Hello world\n", applied.getOps().get(0).text());
    }

    @Test
    void 应删除指定区间() {
        Delta document = new Delta().insert("Hello\n");
        Delta change = new Delta().retain(1).delete(4);

        Delta applied = DeltaApply.apply(document, change);

        assertEquals("H\n", applied.getOps().get(0).text());
    }

    @Test
    void retain属性应能移除已有格式() {
        Map<String, Object> bold = Map.of("bold", true);
        Map<String, Object> removeBold = new LinkedHashMap<>();
        removeBold.put("bold", null);

        Delta document = new Delta().insert("Hi", bold).insert("\n");
        Delta change = new Delta().retain(2, removeBold);

        Delta applied = DeltaApply.apply(document, change);

        assertEquals("Hi\n", applied.getOps().get(0).text());
        assertNull(applied.getOps().get(0).getAttributes());
    }

    @Test
    void 超出文档长度的操作必须失败() {
        IllegalArgumentException exception = assertThrows(
                IllegalArgumentException.class,
                () -> DeltaApply.apply(new Delta().insert("A"), new Delta().retain(2))
        );

        assertEquals("修改操作超出了文档长度", exception.getMessage());
    }

    @Test
    void 嵌入对象的属性可通过retain更新() {
        var image = new ObjectMapper().createObjectNode().put("image", "https://example.test/a.png");
        Delta document = new Delta().insert("A")
                .push(Op.insertEmbed(image, Map.of("width", 100)))
                .insert("\n");
        Delta change = new Delta().retain(1).retain(1, Map.of("width", 200));

        Delta applied = DeltaApply.apply(document, change);

        assertEquals(200, applied.getOps().get(1).getAttributes().get("width"));
        assertEquals(image, applied.getOps().get(1).getInsert());
    }
}
