package com.school.collab.ot;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Random;

import static org.junit.jupiter.api.Assertions.assertEquals;

/** TP1: apply(a, b') 必须等于 apply(b, a')。 */
class DeltaTransformTp1Test {

    private static final int CASE_COUNT = 10_000;
    private static final long SEED = 20260915L;

    @Test
    void 一万组随机并发编辑必须收敛() {
        Random random = new Random(SEED);

        for (int caseIndex = 0; caseIndex < CASE_COUNT; caseIndex++) {
            Delta document = new Delta().insert(randomText(random, 1 + random.nextInt(20)));
            if (random.nextBoolean()) {
                document.push(Op.insertEmbed(
                        new ObjectMapper().createObjectNode().put("image", "https://example.test/a.png")));
            }
            document.insert("\n");
            int documentLength = document.length();
            Delta a = randomChange(random, documentLength);
            Delta b = randomChange(random, documentLength);

            // A 取优先级；换另一条路径时，A 仍须保持优先级。
            Delta bAfterA = DeltaTransform.transform(a, b, true);
            Delta aAfterB = DeltaTransform.transform(b, a, false);

            Delta left = DeltaApply.apply(DeltaApply.apply(document, a), bAfterA);
            Delta right = DeltaApply.apply(DeltaApply.apply(document, b), aAfterB);
            int failingCase = caseIndex;

            assertEquals(
                    left.getOps(),
                    right.getOps(),
                    () -> "TP1 不收敛，case=" + failingCase
                            + ", document=" + document.getOps()
                            + ", a=" + a.getOps()
                            + ", b=" + b.getOps()
            );
        }
    }

    private static Delta randomChange(Random random, int baseLength) {
        Delta result = new Delta();
        int consumed = 0;

        while (consumed < baseLength) {
            if (random.nextBoolean()) {
                result.insert(randomText(random, 1 + random.nextInt(3)));
            }

            int length = Math.min(1 + random.nextInt(3), baseLength - consumed);
            if (random.nextBoolean()) {
                if (random.nextInt(4) == 0) {
                    Map<String, Object> attributes = new LinkedHashMap<>();
                    attributes.put("bold", random.nextBoolean() ? true : null);
                    result.retain(length, attributes);
                } else {
                    result.retain(length);
                }
            } else {
                result.delete(length);
            }
            consumed += length;
        }

        if (random.nextBoolean()) {
            result.insert(randomText(random, 1 + random.nextInt(3)));
        }
        return result.chop();
    }

    private static String randomText(Random random, int length) {
        StringBuilder text = new StringBuilder(length);
        for (int i = 0; i < length; i++) {
            text.append((char) ('a' + random.nextInt(26)));
        }
        return text.toString();
    }
}
