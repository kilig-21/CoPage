package com.school.collab.ot;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

class DeltaTransformTest {

    @Test
    void 同一位置并发插入应按优先级稳定排序() {
        Delta document = new Delta().insert("A\n");
        Delta first = new Delta().retain(1).insert("X");
        Delta second = new Delta().retain(1).insert("Y");

        Delta secondAfterFirst = DeltaTransform.transform(first, second, true);
        Delta firstAfterSecond = DeltaTransform.transform(second, first, false);

        assertEquals("AXY\n", text(DeltaApply.apply(DeltaApply.apply(document, first), secondAfterFirst)));
        assertEquals("AXY\n", text(DeltaApply.apply(DeltaApply.apply(document, second), firstAfterSecond)));
    }

    @Test
    void 对已删除文本的重复删除应消失() {
        Delta document = new Delta().insert("abc\n");
        Delta first = new Delta().delete(1);
        Delta second = new Delta().delete(1);

        Delta secondAfterFirst = DeltaTransform.transform(first, second, true);

        assertEquals("bc\n", text(DeltaApply.apply(DeltaApply.apply(document, first), secondAfterFirst)));
        assertEquals(0, secondAfterFirst.getOps().size());
    }

    @Test
    void 光标在同位置应由优先级决定是否后移() {
        Delta insertAtOne = new Delta().retain(1).insert("X");

        assertEquals(2, DeltaTransform.transformPosition(insertAtOne, 1, false));
        assertEquals(1, DeltaTransform.transformPosition(insertAtOne, 1, true));
    }

    @Test
    void 光标应随前方删除左移() {
        Delta deleteFirstTwo = new Delta().delete(2);

        assertEquals(2, DeltaTransform.transformPosition(deleteFirstTwo, 4, false));
    }

    @Test
    void 删除后同位置插入仍需转换光标() {
        Delta replaceMiddle = new Delta().retain(1).delete(2).insert("XY");

        assertEquals(4, DeltaTransform.transformPosition(replaceMiddle, 4, false));
        assertEquals(3, DeltaTransform.transformPosition(replaceMiddle, 3, false));
    }

    private static String text(Delta delta) {
        return delta.getOps().stream()
                .filter(Op::isTextInsert)
                .map(Op::text)
                .reduce("", String::concat);
    }
}
