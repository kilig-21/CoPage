package com.school.collab.ot;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

class OpIteratorTest {

    @Test
    void 应按请求长度切分文本插入() {
        OpIterator iterator = new OpIterator(new Delta().insert("Hello").getOps());

        assertEquals("He", iterator.next(2).text());
        assertEquals("llo", iterator.next().text());
        assertFalse(iterator.hasNext());
    }
}
