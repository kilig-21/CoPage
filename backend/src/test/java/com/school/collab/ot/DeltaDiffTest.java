package com.school.collab.ot;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Random;

import static org.junit.jupiter.api.Assertions.*;

class DeltaDiffTest {
    private static Delta text(String value) { return new Delta().insert(value); }
    private static void applies(Delta before, Delta after) {
        List<Op> original = before.getOps(), target = after.getOps();
        assertEquals(target, DeltaApply.apply(before, DeltaDiff.diff(before, after)).getOps());
        assertEquals(original, before.getOps()); assertEquals(target, after.getOps());
    }

    @Test void retainsUnchangedRunsAndRemovesOnlyChangedAttributes() {
        Delta before = new Delta().insert("共享", Map.of("bold", true, "color", "red"))
                .insert("旧段落").insert("\n", Map.of("header", 2));
        Delta after = new Delta().insert("共享", Map.of("bold", true, "italic", true))
                .insert("新段落").insert("\n", Map.of("align", "center"));
        applies(before, after);
        Delta change = DeltaDiff.diff(before, after);
        Op shared = change.getOps().getFirst();
        assertEquals(2, shared.getRetain());
        assertTrue(shared.getAttributes().containsKey("color")); assertNull(shared.getAttributes().get("color"));
        assertEquals(true, shared.getAttributes().get("italic")); assertFalse(shared.getAttributes().containsKey("bold"));
        assertTrue(change.getOps().stream().anyMatch(op -> op.isRetain() && op.getAttributes() != null && op.getAttributes().containsKey("header")));
    }

    @Test void sameAndDifferentEmbedsHaveTheirOwnIdentityIndependentOfAttributes() {
        var mapper = new ObjectMapper();
        var image = mapper.createObjectNode().put("image", "https://example.test/a.png");
        var other = mapper.createObjectNode().put("image", "https://example.test/b.png");
        Delta before = new Delta().insert("左").push(Op.insertEmbed(image, Map.of("width", "20"))).insert("中")
                .push(Op.insertEmbed(other)).insert("尾\n");
        Delta after = new Delta().insert("左").push(Op.insertEmbed(image, Map.of("width", "40"))).insert("中")
                .push(Op.insertEmbed(mapper.createObjectNode().put("image", "https://example.test/c.png"))).insert("尾\n");
        applies(before, after);
        assertTrue(DeltaDiff.diff(before, after).getOps().stream().anyMatch(op -> op.isRetain() && Map.of("width", "40").equals(op.getAttributes())));
        // An embedded object is never confused with literal NUL or an unrelated image.
        applies(new Delta().insert("\0").push(Op.insertEmbed(image)).insert("\n"),
                new Delta().push(Op.insertEmbed(other)).insert("\0\n"));
    }

    @Test void unicodeAlignsWholeCodePointsButEmitsUtf16Coordinates() {
        Delta before = text("A😀共同🧭Z\n"), after = text("A😁共同🧭Y\n");
        applies(before, after);
        for (Op op : DeltaDiff.diff(before, after).getOps()) if (op.isTextInsert()) {
            String s = op.text();
            assertFalse(Character.isLowSurrogate(s.charAt(0)));
            assertFalse(Character.isHighSurrogate(s.charAt(s.length() - 1)));
        }
        // Formatting boundaries may legally split UTF-16 units in existing data.
        applies(new Delta().insert("\ud83d", Map.of("bold", true)).insert("\ude00\n"), text("😀\n"));
    }

    @Test void finalNewlineIsRetainedEvenWhenBodiesHaveNoCommonContent() {
        Delta before = text("旧正文\n"), after = text("ABC\n");
        Delta change = DeltaDiff.diff(before, after);
        applies(before, after);
        int removed = change.getOps().stream().filter(Op::isDelete).mapToInt(Op::length).sum();
        assertEquals(3, removed);
        Delta lateInsert = new Delta().retain(3).insert("晚到");
        Delta rebased = DeltaTransform.transform(change, lateInsert, true);
        assertEquals(text("ABC晚到\n").getOps(), DeltaApply.apply(after, rebased).getOps());
        applies(text("\n"), text("\n\n")); applies(text("\n\n"), text("\n"));
    }

    @Test void disjointFormatChangeSurvivesOnPreservedSharedText() {
        Delta before = text("共同旧尾\n"), after = text("共同新尾\n");
        Delta lateFormat = new Delta().retain(2, Map.of("bold", true));
        Delta actual = DeltaApply.apply(after, DeltaTransform.transform(DeltaDiff.diff(before, after), lateFormat, true));
        assertEquals(new Delta().insert("共同", Map.of("bold", true)).insert("新尾\n").getOps(), actual.getOps());
    }

    @Test void literalNullAttributesReplaceOnlyTheAffectedRunAndKeepOtherSharedFormatting() {
        Map<String, Object> literalNull = java.util.Collections.singletonMap("color", null);
        Delta before = text("共享中间尾\n");
        Delta after = new Delta().insert("共享").insert("中间", literalNull).insert("尾\n");
        applies(before, after);
        Delta change = DeltaDiff.diff(before, after);
        assertEquals(2, change.getOps().stream().filter(Op::isDelete).mapToInt(Op::length).sum());
        Delta lateBold = new Delta().retain(2, Map.of("bold", true));
        assertEquals(new Delta().insert("共享", Map.of("bold", true)).insert("中间", literalNull).insert("尾\n").getOps(),
                DeltaApply.apply(after, DeltaTransform.transform(change, lateBold, true)).getOps());
        Map<String, Object> both = new java.util.LinkedHashMap<>(literalNull);
        both.put("italic", true);
        Delta existing = new Delta().insert("正文", literalNull).insert("\n");
        assertTrue(DeltaDiff.diff(existing, existing).getOps().isEmpty());
        applies(existing, new Delta().insert("正文", both).insert("\n"));
        var image = new ObjectMapper().createObjectNode().put("image", "https://example.test/a.png");
        applies(new Delta().insert("左").push(Op.insertEmbed(image, Map.of("width", "40"))).insert("右\n"),
                new Delta().insert("左").push(Op.insertEmbed(image, java.util.Collections.singletonMap("width", null))).insert("右\n"));
    }

    @Test void literalNullReplacementExpandsToWholeSurrogatePairAcrossExistingFormatRuns() {
        Map<String, Object> literalNull = java.util.Collections.singletonMap("color", null);
        for (Delta after : List.of(
                new Delta().insert("前").insert("\ud83d", literalNull).insert("\ude00后\n"),
                new Delta().insert("前\ud83d").insert("\ude00", literalNull).insert("后\n"))) {
            Delta before = text("前😀后\n");
            applies(before, after);
            Delta change = DeltaDiff.diff(before, after);
            assertEquals(2, change.getOps().stream().filter(Op::isDelete).mapToInt(Op::length).sum());
            assertEquals(1, change.getOps().getFirst().getRetain());
        }
    }

    @Test void singleLiteralNullTargetRunDoesNotCopyItsTextOncePerOldFormattingRun() throws Exception {
        String piece = "abcdefghijklmnopqrstuvwx😀";
        int runs = 24_000;
        Delta before = new Delta().insert("前");
        for (int i = 0; i < runs; i++) before.insert(piece, Map.of("bold", i % 2 == 0));
        before.insert("\n");
        Delta after = new Delta().insert("前").insert(piece.repeat(runs), java.util.Collections.singletonMap("color", null)).insert("\n");
        ObjectMapper mapper = new ObjectMapper();
        int sourceBytes = mapper.writeValueAsBytes(before).length, targetBytes = mapper.writeValueAsBytes(after).length;
        assertTrue(sourceBytes <= 2 * 1024 * 1024); assertTrue(targetBytes <= 2 * 1024 * 1024);
        var originals = before.getOps(); var target = after.getOps();
        var bean = java.lang.management.ManagementFactory.getThreadMXBean();
        org.junit.jupiter.api.Assumptions.assumeTrue(bean instanceof com.sun.management.ThreadMXBean allocation
                && allocation.isThreadAllocatedMemorySupported());
        var allocation = (com.sun.management.ThreadMXBean) bean;
        if (!allocation.isThreadAllocatedMemoryEnabled()) allocation.setThreadAllocatedMemoryEnabled(true);
        long threadId = Thread.currentThread().threadId();
        long allocatedBefore = allocation.getThreadAllocatedBytes(threadId), started = System.nanoTime();
        Delta change = assertTimeout(Duration.ofSeconds(10), () -> DeltaDiff.diff(before, after));
        long allocated = allocation.getThreadAllocatedBytes(threadId) - allocatedBefore;
        System.out.printf("RESTORE_DIFF literal-null-single-run oldRuns=%d sourceBytes=%d targetBytes=%d allocatedBytes=%d elapsedMs=%.3f%n",
                runs, sourceBytes, targetBytes, allocated, (System.nanoTime() - started) / 1_000_000.0);
        // The source is <2 MiB. Repeatedly concatenating the target run copies
        // tens of GiB even if a fast machine masks that cost in wall-clock time.
        assertTrue(allocated < 128L * 1024 * 1024, "恢复一个目标格式段不应按每个旧格式边界重复复制整段文字: " + allocated);
        assertEquals(3, change.operationCount());
        assertEquals(target, DeltaApply.apply(before, change).getOps());
        assertEquals(originals, before.getOps()); assertEquals(target, after.getOps());
        Delta late = new Delta().retain(1, Map.of("italic", true));
        converges(before, after, change, late);
        assertEquals(Boolean.TRUE, DeltaApply.apply(after, DeltaTransform.transform(change, late, true))
                .getOps().getFirst().getAttributes().get("italic"));
    }

    @Test void newLiteralNullOnTerminalNewlineIsRejectedButAnExistingOneIsRetainedExactly() {
        Map<String, Object> literalNull = java.util.Collections.singletonMap("align", null);
        Delta before = text("正文\n"), after = new Delta().insert("正文").insert("\n", literalNull);
        assertThrows(DeltaDiff.TerminalNewlineAttributeException.class, () -> DeltaDiff.diff(before, after));
        assertEquals(text("正文\n").getOps(), before.getOps());
        assertTrue(DeltaDiff.diff(after, after).getOps().isEmpty());
        Map<String, Object> changed = new java.util.LinkedHashMap<>(literalNull); changed.put("header", 2);
        Delta changedAfter = new Delta().insert("正文").insert("\n", changed);
        applies(after, changedAfter);
        assertTrue(DeltaDiff.diff(after, changedAfter).getOps().stream().noneMatch(op -> op.isDelete() || op.isInsert()));
        applies(after, text("正文\n"));
    }

    @Test void shortRandomInputsMatchIndependentMinimalEditDistanceAndRoundTrip() {
        Random random = new Random(2501024);
        for (int run = 0; run < 2000; run++) {
            String a = randomText(random), b = randomText(random);
            Delta before = text(a + "\n"), after = text(b + "\n");
            Delta change = DeltaDiff.diff(before, after);
            assertEquals(after.getOps(), DeltaApply.apply(before, change).getOps(), a + " -> " + b);
            int cost = change.getOps().stream().filter(op -> !op.isRetain()).mapToInt(Op::length).sum();
            assertEquals(distance(a, b), cost, a + " -> " + b);
        }
    }

    private static String randomText(Random random) {
        StringBuilder value = new StringBuilder();
        int length = random.nextInt(24);
        for (int i = 0; i < length; i++) value.append((char) ('a' + random.nextInt(4)));
        return value.toString();
    }

    // Tiny test oracle only; production never allocates an N*M matrix.
    private static int distance(String a, String b) {
        int[][] d = new int[a.length() + 1][b.length() + 1];
        for (int i = 0; i <= a.length(); i++) d[i][0] = i;
        for (int j = 0; j <= b.length(); j++) d[0][j] = j;
        for (int i = 1; i <= a.length(); i++) for (int j = 1; j <= b.length(); j++)
            d[i][j] = a.charAt(i - 1) == b.charAt(j - 1) ? d[i - 1][j - 1] : Math.min(d[i - 1][j], d[i][j - 1]) + 1;
        return d[a.length()][b.length()];
    }

    @Test void legalLargeBodyLocalEditAndDisjointReplacementHaveBoundedLinearPaths() {
        assertTimeout(Duration.ofSeconds(10), () -> {
            String common = "x".repeat(1_000_000);
            Delta before = text(common + "旧" + common + "\n"), after = text(common + "新" + common + "\n");
            applies(before, after);
            assertEquals(3, DeltaDiff.diff(before, after).getOps().size());
            applies(text("a".repeat(1_000_000) + "\n"), text("b".repeat(1_000_000) + "\n"));
        });
    }

    @Test void ordinaryWholeBodyRewritesAndBlockMovesMustNotHitTheComplexityLimit() {
        Random random = new Random(2501025);
        String alphabet = "项目会议产品任务需求计划时间记录讨论用户客户负责明确交付确认整理验收进度下周流程资料内容，。：；\n";
        StringBuilder randomBefore = new StringBuilder(), randomAfter = new StringBuilder();
        for (int i = 0; i < 5000; i++) {
            randomBefore.append(alphabet.charAt(random.nextInt(alphabet.length())));
            randomAfter.append(alphabet.charAt(random.nextInt(alphabet.length())));
        }
        String[][] cases = {
                {"paragraph-rewrite-200", "会议记录：讨论项目进度，明确下周任务及负责人。\n".repeat(200),
                        "客户访谈：确认产品需求，整理交付计划和验收时间。\n".repeat(200)},
                {"paragraph-rewrite-500", "会议记录：讨论项目进度，明确下周任务及负责人。\n".repeat(500),
                        "客户访谈：确认产品需求，整理交付计划和验收时间。\n".repeat(500)},
                {"block-move-16K", "a".repeat(8000) + "b".repeat(8000), "b".repeat(8000) + "a".repeat(8000)},
                {"scattered-common-5K", randomBefore.toString(), randomAfter.toString()}
        };
        for (String[] sample : cases) {
            Delta before = text(sample[1] + "\n"), after = text(sample[2] + "\n");
            long started = System.nanoTime();
            assertTimeout(Duration.ofSeconds(10), () -> {
                Delta change = DeltaDiff.diff(before, after);
                assertEquals(after.getOps(), DeltaApply.apply(before, change).getOps());
            });
            System.out.printf("RESTORE_DIFF %s chars=%d/%d outcome=accepted elapsedMs=%.3f%n",
                    sample[0], sample[1].length(), sample[2].length(),
                    (System.nanoTime() - started) / 1_000_000.0);
        }
    }

    @Test void ordinaryTwentyFourThousandCharacterRewriteIsRefinedWithoutRefusal() {
        Delta before = text("会议记录：讨论项目进度，明确下周任务及负责人。\n".repeat(1000) + "\n");
        Delta after = text("客户访谈：确认产品需求，整理交付计划和验收时间。\n".repeat(1000) + "\n");
        var original = before.getOps(); var target = after.getOps();
        long started = System.nanoTime();
        assertTimeout(Duration.ofSeconds(10), () -> {
            Delta change = DeltaDiff.diff(before, after);
            assertEquals(target, DeltaApply.apply(before, change).getOps());
            assertTrue(change.getOps().stream().anyMatch(Op::isRetain));
        });
        assertEquals(original, before.getOps()); assertEquals(target, after.getOps());
        System.out.printf("RESTORE_DIFF paragraph-rewrite-1000 chars=24000/25000 outcome=accepted elapsedMs=%.3f%n",
                (System.nanoTime() - started) / 1_000_000.0);
    }

    @Test void shiftedLongCommonBlocksKeepTheirIdentityAndCrossBoundaryPendingEditsConverge() {
        String common = "共同段落abcdefghij😀".repeat(200);
        Delta before = text("旧前缀" + common + "旧后缀\n");
        Delta after = text("新开头插入改变切块边界" + common + "历史尾部\n");
        Delta change = DeltaDiff.diff(before, after);
        assertEquals(after.getOps(), DeltaApply.apply(before, change).getOps());
        int location = 3 + 63; // crosses a 64-code-point refinement boundary.
        List<Delta> pending = List.of(new Delta().retain(location).insert("晚到😀"),
                new Delta().retain(location).delete(9), new Delta().retain(location).retain(70, Map.of("bold", true)),
                new Delta().retain(before.length() - 1).insert("末尾"));
        for (Delta edit : pending) converges(before, after, change, edit);
        Delta bold = new Delta().retain(3 + 80).retain(8, Map.of("italic", true));
        Delta actual = DeltaApply.apply(after, DeltaTransform.transform(change, bold, true));
        assertEquals(8, actual.getOps().stream().filter(op -> op.getAttributes() != null
                && Boolean.TRUE.equals(op.getAttributes().get("italic"))).mapToInt(Op::length).sum());
    }

    @Test void largeImageAndEmojiNeighborsConvergeForLateInsertDeleteAndFormat() {
        var image = new ObjectMapper().createObjectNode().put("image", "https://example.test/anchor.png");
        String left = "段落甲abc😀".repeat(40), right = "段落乙def🧭".repeat(40);
        Delta before = new Delta().insert("旧开头" + left).push(Op.insertEmbed(image)).insert(right + "旧尾\n");
        Delta after = new Delta().insert("历史新开头" + left).push(Op.insertEmbed(image)).insert(right + "新尾\n");
        Delta change = DeltaDiff.diff(before, after);
        int atImage = 3 + left.length();
        for (Delta edit : List.of(new Delta().retain(atImage).insert("图片旁😀"), new Delta().retain(atImage).delete(1),
                new Delta().retain(atImage - 2).retain(5, Map.of("bold", true)))) converges(before, after, change, edit);
    }

    private static void converges(Delta before, Delta target, Delta change, Delta pending) {
        Delta restoredFirst = DeltaApply.apply(target, DeltaTransform.transform(change, pending, true));
        Delta pendingFirst = DeltaApply.apply(DeltaApply.apply(before, pending), DeltaTransform.transform(pending, change, false));
        assertEquals(restoredFirst.getOps(), pendingFirst.getOps());
        assertTrue(restoredFirst.getOps().getLast().text().endsWith("\n"));
    }

    @Test void legalTwoMiBBodyCanBeLargelyRewrittenWhileKeepingItsSharedMiddle() throws Exception {
        int bytes = 2 * 1024 * 1024;
        ObjectMapper mapper = new ObjectMapper();
        String shared = "共享😀重要正文".repeat(100);
        int overhead = mapper.writeValueAsBytes(text(shared + "\n")).length;
        int padding = bytes - overhead;
        String leftA = "a".repeat(padding / 2), rightA = "a".repeat(padding - padding / 2);
        String leftB = "b".repeat(padding / 2 + 7), rightB = "b".repeat(padding - padding / 2 - 7);
        Delta before = text(leftA + shared + rightA + "\n"), after = text(leftB + shared + rightB + "\n");
        assertEquals(bytes, mapper.writeValueAsBytes(before).length);
        assertEquals(bytes, mapper.writeValueAsBytes(after).length);
        long started = System.nanoTime();
        Delta change = assertTimeout(Duration.ofSeconds(10), () -> DeltaDiff.diff(before, after));
        assertEquals(after.getOps(), DeltaApply.apply(before, change).getOps());
        assertTrue(mapper.writeValueAsBytes(change).length < 4 * 1024 * 1024);
        Delta late = new Delta().retain(leftA.length() + 100).retain(40, Map.of("bold", true));
        converges(before, after, change, late);
        Delta merged = DeltaApply.apply(after, DeltaTransform.transform(change, late, true));
        assertEquals(40, merged.getOps().stream().filter(op -> op.getAttributes() != null
                && Boolean.TRUE.equals(op.getAttributes().get("bold"))).mapToInt(Op::length).sum());
        System.out.printf("RESTORE_DIFF two-MiB-major-rewrite contentBytes=%d operationBytes=%d ops=%d elapsedMs=%.3f%n",
                bytes, mapper.writeValueAsBytes(change).length, change.getOps().size(), (System.nanoTime() - started) / 1_000_000.0);
    }

    @Test void adjacentChangedFinePiecesMaterializeOneInsertWithoutRepeatedTextConcatenation() {
        Delta before = text("a".repeat(400_000) + "z" + "a".repeat(400_000) + "\n");
        Delta after = text("b".repeat(200_000) + "z" + "b".repeat(600_000) + "\n");
        Delta change = assertTimeout(Duration.ofSeconds(5), () -> DeltaDiff.diff(before, after));
        assertEquals(2, change.operationCount());
        assertEquals(after.getOps(), DeltaApply.apply(before, change).getOps());
    }

    @Test void workBudgetRefusesComplexAlignmentWithoutMutatingEitherDocument() {
        Delta before = text("ab".repeat(100) + "\n"), after = text("ba".repeat(100) + "\n");
        var old = before.getOps(); var target = after.getOps();
        assertThrows(DeltaDiff.ComplexityLimitException.class, () -> DeltaDiff.diff(before, after, 1));
        assertEquals(old, before.getOps()); assertEquals(target, after.getOps());
        assertThrows(IllegalArgumentException.class, () -> DeltaDiff.diff(new Delta().retain(1), text("\n")));
    }

    @Test void identicalBodyProducesNoContentOrAttributeEdits() {
        Delta body = new Delta().insert("同", Map.of("bold", true)).insert("\n");
        assertTrue(DeltaDiff.diff(body, body).getOps().isEmpty()); applies(body, body);
        applies(new Delta(), text("a\n")); applies(text("a\n"), new Delta());
    }
}
