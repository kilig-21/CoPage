package com.school.collab.ot;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;

import static org.junit.jupiter.api.Assertions.assertEquals;

/** TP1: apply(a, b') 必须等于 apply(b, a')。 */
class DeltaTransformTp1Test {

    private static final int CASE_COUNT = 10_000;
    private static final long SEED = 20260915L;
    private static final int FORMATTED_CASE_COUNT = 20_000;
    private static final long FORMATTED_SEED = 20261122L;
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final List<String> TEXT_ATTRIBUTES = List.of("bold", "italic", "color", "background");
    private static final List<String> LINE_ATTRIBUTES = List.of("header", "indent");
    private static final List<String> IMAGE_ATTRIBUTES = List.of("width", "height", "alt");
    private static final List<String> RETAIN_ATTRIBUTES = List.of("bold", "italic", "color", "background",
            "header", "indent", "width", "height", "alt");

    @Test
    void 一万组随机并发编辑必须收敛() {
        Random random = new Random(SEED);

        for (int caseIndex = 0; caseIndex < CASE_COUNT; caseIndex++) {
            Delta document = new Delta().insert(randomText(random, 1 + random.nextInt(20)));
            if (random.nextBoolean()) {
                document.push(Op.insertEmbed(
                        image("a")));
            }
            document.insert("\n");
            int documentLength = document.length();
            Delta a = randomChange(random, documentLength);
            Delta b = randomChange(random, documentLength);

            converge(document, a, b, true, SEED, caseIndex);
        }
    }

    @Test
    void 两万组带格式并发编辑在两种优先级下收敛() {
        var random = new Random(FORMATTED_SEED);
        for (int i = 0; i < FORMATTED_CASE_COUNT; i++) {
            Delta document = new Delta().insert(randomText(random, 1 + random.nextInt(12)),
                    attributes(random, TEXT_ATTRIBUTES, false));
            if (random.nextBoolean()) document.push(Op.insertEmbed(image("base"), attributes(random, IMAGE_ATTRIBUTES, false)));
            document.insert("\n", Map.of("header", 1 + random.nextInt(6)));
            Delta a = formattedChange(random, document.length());
            Delta b = formattedChange(random, document.length());
            converge(document, a, b, true, FORMATTED_SEED, i);
            converge(document, a, b, false, FORMATTED_SEED, i);
        }
    }

    @Test
    void 标题级别文字颜色和图片宽度冲突遵循同一优先级() {
        var document = new Delta().insert("X", Map.of("color", "blue", "bold", true))
                .push(Op.insertEmbed(image("base"), Map.of("width", "240", "alt", "旧说明")))
                .insert("\n", Map.of("header", 1));
        Map<String, Object> aText = new LinkedHashMap<>();
        aText.put("color", "red");
        aText.put("bold", null);
        var a = new Delta().retain(1, aText).retain(1, Map.of("width", "320", "height", "50%"))
                .retain(1, Map.of("header", 2));
        var b = new Delta().retain(1, Map.of("color", "green", "italic", true))
                .retain(1, Map.of("width", "75%", "alt", "新说明"))
                .retain(1, Map.of("header", 4, "align", "right"));

        var expected = new Delta().insert("X", Map.of("color", "red", "italic", true))
                .push(Op.insertEmbed(image("base"), Map.of("width", "320", "height", "50%", "alt", "新说明")))
                .insert("\n", Map.of("header", 2, "align", "right"));
        assertEquals(expected.getOps(), converge(document, a, b, true, 0, 0).getOps());
    }

    @Test
    void 同位置插入各自保留文本颜色与图片宽度() {
        var document = new Delta().insert("\n");
        var a = new Delta().insert("A", Map.of("color", "red", "bold", true));
        var b = new Delta().push(Op.insertEmbed(image("b"), Map.of("width", "80%", "alt", "说明")));

        var textFirst = new Delta().push(a.getOps().getFirst()).push(b.getOps().getFirst()).insert("\n");
        var imageFirst = new Delta().push(b.getOps().getFirst()).push(a.getOps().getFirst()).insert("\n");
        assertEquals(textFirst.getOps(), converge(document, a, b, true, 0, 0).getOps());
        assertEquals(imageFirst.getOps(), converge(document, a, b, false, 0, 0).getOps());
    }

    @Test
    void 分段不同的合法操作归一化后保留收敛结果() {
        var document = new Delta().insert("ABC\n");
        var color = Map.<String, Object>of("color", "red");
        var split = new Delta(List.of(Op.delete(1), Op.insert("X", color), Op.insert("Y", color), Op.delete(1)));
        var combined = new Delta().insert("XY", color).delete(2);
        var concurrent = new Delta().retain(1).insert("Z", Map.of("bold", true));
        assertEquals(combined.getOps(), split.getOps());
        assertEquals(converge(document, combined, concurrent, true, 0, 0).getOps(),
                converge(document, split, concurrent, true, 0, 0).getOps());
    }

    private static Delta converge(Delta document, Delta a, Delta b, boolean aFirst, long seed, int index) {
        Delta left = DeltaApply.apply(DeltaApply.apply(document, a), DeltaTransform.transform(a, b, aFirst));
        Delta right = DeltaApply.apply(DeltaApply.apply(document, b), DeltaTransform.transform(b, a, !aFirst));
        assertEquals(left.getOps(), right.getOps(), () -> "TP1 seed=" + seed + ", case=" + index + ", aFirst=" + aFirst
                + ", document=" + document.getOps() + ", a=" + a.getOps() + ", b=" + b.getOps());
        return left;
    }

    private static Delta formattedChange(Random random, int baseLength) {
        var result = new Delta();
        int remaining = baseLength - 1;
        while (remaining > 0) {
            if (random.nextBoolean()) insertFormatted(random, result);
            int count = Math.min(1 + random.nextInt(3), remaining);
            if (random.nextInt(4) == 0) result.delete(count);
            else result.retain(count, attributes(random, RETAIN_ATTRIBUTES, true));
            remaining -= count;
        }
        if (random.nextBoolean()) insertFormatted(random, result);
        if (random.nextBoolean()) result.retain(1, attributes(random, LINE_ATTRIBUTES, true));
        return result.chop();
    }

    private static void insertFormatted(Random random, Delta result) {
        switch (random.nextInt(5)) {
            case 0 -> result.push(Op.insertEmbed(image("added"), attributes(random, IMAGE_ATTRIBUTES, false)));
            case 1 -> result.insert("\n", attributes(random, LINE_ATTRIBUTES, false));
            default -> result.insert(randomText(random, 1 + random.nextInt(3)), attributes(random, TEXT_ATTRIBUTES, false));
        }
    }

    private static Map<String, Object> attributes(Random random, List<String> names, boolean allowRemoval) {
        int first = random.nextInt(names.size());
        var result = new LinkedHashMap<String, Object>();
        addAttribute(result, names.get(first), random, allowRemoval);
        if (random.nextBoolean()) {
            int second = (first + 1 + random.nextInt(names.size() - 1)) % names.size();
            addAttribute(result, names.get(second), random, allowRemoval);
        }
        return result;
    }

    private static void addAttribute(Map<String, Object> attributes, String key, Random random, boolean allowRemoval) {
        Object value = switch (key) {
            case "header" -> 1 + random.nextInt(6);
            case "indent" -> random.nextInt(9);
            case "width", "height" -> random.nextBoolean() ? "75%" : "320";
            case "alt" -> random.nextBoolean() ? "图表" : "示例";
            case "color", "background" -> random.nextBoolean() ? "#336699" : "red";
            default -> random.nextBoolean();
        };
        attributes.put(key, allowRemoval && random.nextInt(5) == 0 ? null : value);
    }

    private static ObjectNode image(String name) {
        return MAPPER.createObjectNode().put("image", "https://example.test/" + name + ".png");
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
