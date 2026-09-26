package com.school.collab.collab.persist;

import com.school.collab.ot.Delta;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;

class OperationFingerprintTest {

    @Test
    void attributeOrderDoesNotChangeTheRequestIdentity() {
        Map<String, Object> firstAttributes = new LinkedHashMap<>();
        firstAttributes.put("bold", true);
        firstAttributes.put("color", "red");
        Map<String, Object> reorderedAttributes = new LinkedHashMap<>();
        reorderedAttributes.put("color", "red");
        reorderedAttributes.put("bold", true);

        String first = OperationFingerprint.of(3, new Delta().insert("X", firstAttributes));
        String reordered = OperationFingerprint.of(3, new Delta().insert("X", reorderedAttributes));

        assertEquals(first, reordered);
        assertNotEquals(first, OperationFingerprint.of(4, new Delta().insert("X", firstAttributes)));
        assertNotEquals(first, OperationFingerprint.of(3, new Delta().insert("Y", firstAttributes)));
    }
}
