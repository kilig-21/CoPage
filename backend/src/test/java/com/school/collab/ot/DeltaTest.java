package com.school.collab.ot;

import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class DeltaTest {

    @Test
    void 应合并相邻文本插入() {
        Delta delta = new Delta()
                .insert("A")
                .insert("B")
                .insert("C");

        assertEquals(1, delta.getOps().size());
        assertEquals("ABC", delta.getOps().get(0).text());
    }

    @Test
    void 应合并相邻删除() {
        Delta delta = new Delta()
                .delete(2)
                .delete(3);

        assertEquals(1, delta.getOps().size());
        assertTrue(delta.getOps().get(0).isDelete());
        assertEquals(5, delta.getOps().get(0).length());
    }

    @Test
    void 同一位置插入必须排在删除前() {
        Delta delta = new Delta()
                .delete(2)
                .insert("X");

        assertEquals(2, delta.getOps().size());
        assertTrue(delta.getOps().get(0).isInsert());
        assertEquals("X", delta.getOps().get(0).text());
        assertTrue(delta.getOps().get(1).isDelete());
    }

    @Test
    void 不同格式的相邻插入不能合并() {
        Delta delta = new Delta()
                .insert("A", Map.of("bold", true))
                .insert("B", Map.of("italic", true));

        assertEquals(2, delta.getOps().size());
    }

    @Test
    void attributes中的Null必须保留() {
        Map<String, Object> removeBold = new LinkedHashMap<>();
        removeBold.put("bold", null);

        Op op = Op.retain(1, removeBold);

        assertTrue(op.getAttributes().containsKey("bold"));
        assertNull(op.getAttributes().get("bold"));
    }
}