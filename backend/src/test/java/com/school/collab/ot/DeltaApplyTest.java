package com.school.collab.ot;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

class DeltaApplyTest {

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
