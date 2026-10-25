package com.school.collab.ot;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.BitSet;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * Content alignment followed by attribute differences, as in Quill Delta.diff.
 * Myers' linear-space bidirectional bisection is adapted from Google's
 * diff-match-patch (Copyright 2006 Google Inc., Apache License 2.0):
 * https://github.com/google/diff-match-patch/blob/master/java/src/name/fraser/neil/plaintext/diff_match_patch.java
 * https://www.apache.org/licenses/LICENSE-2.0
 * Distributed WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND.
 *
 * <p>Matches Unicode code points and embed values; emits UTF-16 OT lengths.
 * Long differences use independently implemented unique block anchors and a
 * longest increasing subsequence, then refine bounded code-point pieces.
 * Does not promise a globally minimal edit script. Rolling exact block matches
 * tolerate shifted boundaries; repeated blocks use deterministic representative
 * anchors and have no unique semantic identity. The final newline remains a
 * shared anchor, even when the whole preceding body is replaced.</p>
 */
public final class DeltaDiff {
    // Exact Myers is restricted to at most 64 code points per side. Four
    // coarser passes preserve stable common blocks before positional refinement.
    // Cost is O((N+M)*FINE_LIMIT + K log K), not whole-document O((N+M)*D).
    private static final int FINE_LIMIT = 64;
    private static final int MIN_ANCHOR = 4;
    private static final int FIRST_EMBED = Character.MAX_CODE_POINT + 1;

    private DeltaDiff() { }

    public static Delta diff(Delta before, Delta after) {
        return diff(before, after, -1);
    }

    static Delta diff(Delta before, Delta after, long workLimit) {
        Map<JsonNode, Integer> embeds = new HashMap<>();
        Document a = document(before, embeds), b = document(after, embeds);
        List<Span> spans = new ArrayList<>();
        boolean finalNewline = a.size > 0 && b.size > 0
                && a.tokens[a.size - 1] == '\n' && b.tokens[b.size - 1] == '\n';
        int endA = a.size - (finalNewline ? 1 : 0), endB = b.size - (finalNewline ? 1 : 0);
        // A conservative linear guard for the bounded refinement algorithm,
        // rather than a fixed budget that rejects ordinary whole-body rewrites.
        Budget budget = new Budget(workLimit < 0
                ? 16_000_000L + 32L * FINE_LIMIT * ((long) a.size + b.size) : workLimit);
        ArrayDeque<Task> tasks = new ArrayDeque<>();
        if (finalNewline) tasks.push(new Task(Kind.EQUAL, a.size - 1, a.size, b.size - 1, b.size));
        tasks.push(new Task(Kind.DIFF, 0, endA, 0, endB));
        while (!tasks.isEmpty()) {
            Task task = tasks.pop();
            if (task.kind != Kind.DIFF) {
                append(spans, task.kind, task.endA - task.startA); continue;
            }
            int x = task.startA, y = task.startB, ax = task.endA, by = task.endB;
            int start = x;
            while (x < ax && y < by && a.tokens[x] == b.tokens[y]) { budget.step(); x++; y++; }
            append(spans, Kind.EQUAL, x - start);
            int suffix = 0;
            while (x < ax && y < by && a.tokens[ax - 1] == b.tokens[by - 1]) { budget.step(); ax--; by--; suffix++; }
            if (suffix > 0) tasks.push(new Task(Kind.EQUAL, ax, ax + suffix, by, by + suffix));
            int n = ax - x, m = by - y;
            if (n == 0) { append(spans, Kind.INSERT, m); continue; }
            if (m == 0) { append(spans, Kind.DELETE, n); continue; }
            if (n == 1 || m == 1) {
                int match = -1;
                if (n == 1) {
                    for (int i = y; i < by; i++) { budget.step(); if (a.tokens[x] == b.tokens[i]) { match = i; break; } }
                    if (match >= 0) {
                        append(spans, Kind.INSERT, match - y); append(spans, Kind.EQUAL, 1);
                        append(spans, Kind.INSERT, by - match - 1); continue;
                    }
                } else {
                    for (int i = x; i < ax; i++) { budget.step(); if (a.tokens[i] == b.tokens[y]) { match = i; break; } }
                    if (match >= 0) {
                        append(spans, Kind.DELETE, match - x); append(spans, Kind.EQUAL, 1);
                        append(spans, Kind.DELETE, ax - match - 1); continue;
                    }
                }
                append(spans, Kind.DELETE, n); append(spans, Kind.INSERT, m); continue;
            }
            // A normal whole-body replacement with disjoint contents needs no
            // quadratic search. This test is exact, not a similarity heuristic.
            if (!sharesToken(a.tokens, x, ax, b.tokens, y, by, budget)) {
                append(spans, Kind.DELETE, n); append(spans, Kind.INSERT, m); continue;
            }
            if (n > FINE_LIMIT || m > FINE_LIMIT) {
                List<Task> pieces = partition(a.tokens, x, ax, b.tokens, y, by, task.level, budget);
                for (int i = pieces.size() - 1; i >= 0; i--) tasks.push(pieces.get(i));
                continue;
            }
            Split split = bisect(a.tokens, x, ax, b.tokens, y, by, budget);
            if (split == null) {
                // Exhausted the exact edit graph, not a budget/timeout fallback.
                append(spans, Kind.DELETE, n); append(spans, Kind.INSERT, m);
            } else {
                if ((split.x == x && split.y == y) || (split.x == ax && split.y == by)) {
                    throw new IllegalStateException("Diff bisection did not advance");
                }
                tasks.push(new Task(Kind.DIFF, split.x, ax, split.y, by));
                tasks.push(new Task(Kind.DIFF, x, split.x, y, split.y));
            }
        }
        return operation(a, b, spans);
    }

    /** Refuse before persistence rather than erase common identities on a timeout. */
    public static final class ComplexityLimitException extends IllegalArgumentException {
        private ComplexityLimitException() {
            super("历史版本差异过于复杂，本次未恢复，当前正文和历史仍保留。请先保留两版内容后分段整理。");
        }
    }

    /** Retain-null removes a format; it cannot create a literal null on the shared terminator. */
    public static final class TerminalNewlineAttributeException extends IllegalArgumentException {
        private TerminalNewlineAttributeException() {
            super("该历史版本的末尾换行含不兼容的空值格式，本次未恢复；当前正文和历史仍保留。");
        }
    }

    /** A strict JSON lower bound; the persistence layer still measures exact UTF-8 bytes. */
    public static final class OperationSizeLimitException extends IllegalArgumentException {
        private OperationSizeLimitException() {
            super("文档正文最多 2 MiB，单次修改最多 4 MiB；图片使用上传地址保存");
        }
    }

    private static final class Budget {
        private long remaining;
        private Budget(long remaining) { this.remaining = remaining; }
        private void step() { spend(1); }
        private void spend(long work) { if ((remaining -= work) < 0) throw new ComplexityLimitException(); }
    }

    private static boolean sharesToken(int[] a, int startA, int endA, int[] b, int startB, int endB, Budget budget) {
        BitSet values = new BitSet();
        for (int i = startA; i < endA; i++) { budget.step(); values.set(a[i]); }
        for (int j = startB; j < endB; j++) { budget.step(); if (values.get(b[j])) return true; }
        return false;
    }

    private static List<Task> partition(int[] a, int startA, int endA, int[] b, int startB, int endB,
                                        int level, Budget budget) {
        List<Anchor> anchors;
        if (level < 3) {
            Map<Block, Occurrence> matches = new HashMap<>();
            for (Block block : blocks(a, startA, endA, level, budget)) {
                Occurrence occurrence = matches.computeIfAbsent(block, ignored -> new Occurrence(block.start, block.end));
                occurrence.countA++;
            }
            for (Block block : blocks(b, startB, endB, level, budget)) {
                Occurrence occurrence = matches.get(block);
                if (occurrence != null) occurrence.addB(block.start, block.end);
            }
            anchors = anchors(matches, false, budget);
            if (anchors.isEmpty()) return List.of(new Task(Kind.DIFF, startA, endA, startB, endB, level + 1));
        } else if (level == 3) {
            anchors = rollingAnchors(a, startA, endA, b, startB, endB, budget);
        } else anchors = List.of();
        List<Task> pieces = new ArrayList<>();
        if (!anchors.isEmpty()) {
            int x = startA, y = startB;
            for (Anchor anchor : anchors) {
                pieces.add(new Task(Kind.DIFF, x, anchor.startA, y, anchor.startB, level + 1));
                pieces.add(new Task(Kind.EQUAL, anchor.startA, anchor.endA, anchor.startB, anchor.endB));
                x = anchor.endA; y = anchor.endB;
            }
            pieces.add(new Task(Kind.DIFF, x, endA, y, endB, level + 1));
            return pieces;
        }
        // No stable block remains. Refine ordered bounded pieces, including
        // shared characters within each piece; never replace the whole region
        // merely because a global edit-distance search would be expensive.
        int x = startA, y = startB;
        while (x < endA && y < endB) {
            int ax = Math.min(endA, x + FINE_LIMIT), by = Math.min(endB, y + FINE_LIMIT);
            pieces.add(new Task(Kind.DIFF, x, ax, y, by, 4)); x = ax; y = by;
        }
        if (x < endA || y < endB) pieces.add(new Task(Kind.DIFF, x, endA, y, endB, 4));
        return pieces;
    }

    private static List<Block> blocks(int[] values, int start, int end, int level, Budget budget) {
        List<Block> blocks = new ArrayList<>();
        int begin = start;
        for (int i = start; i < end; i++) {
            budget.step();
            int token = values[i];
            boolean separator = level == 0 ? token == '\n'
                    : level == 1 ? "。！？!?；;".indexOf(token) >= 0
                    : Character.isWhitespace(token) || "，,:：".indexOf(token) >= 0;
            if (!separator) continue;
            if (begin < i) blocks.add(new Block(values, begin, i));
            // Delimiters stay separate, so adding a paragraph break does not
            // make the neighboring unchanged text cease being an exact block.
            blocks.add(new Block(values, i, i + 1)); begin = i + 1;
        }
        if (begin < end) blocks.add(new Block(values, begin, end));
        return blocks;
    }

    private static List<Anchor> rollingAnchors(int[] a, int startA, int endA, int[] b, int startB, int endB,
                                                Budget budget) {
        if (endA - startA < FINE_LIMIT || endB - startB < FINE_LIMIT) return List.of();
        Map<Block, Occurrence> matches = new HashMap<>();
        for (int x = startA; x + FINE_LIMIT <= endA; x += FINE_LIMIT) {
            budget.spend(FINE_LIMIT);
            Block block = new Block(a, x, x + FINE_LIMIT);
            matches.computeIfAbsent(block, ignored -> new Occurrence(block.start, block.end)).countA++;
        }
        int power = 1;
        for (int i = 1; i < FINE_LIMIT; i++) power *= 31;
        Block window = new Block(b, startB, startB + FINE_LIMIT);
        int hash = window.hash;
        // Repeated text has no unique ordinal identity. Compare a bounded
        // amount of exact context, instead of mapping a later old repetition
        // blindly to the first new occurrence and deleting a long shared run.
        long[] contextWork = {64L * ((long) endA - startA + endB - startB)};
        Anchor strongest = null;
        for (int y = startB; y + FINE_LIMIT <= endB; y++) {
            budget.step();
            if (y > startB) hash = (hash - b[y - 1] * power) * 31 + b[y + FINE_LIMIT - 1];
            Occurrence occurrence = matches.get(new Block(b, y, y + FINE_LIMIT, hash));
            if (occurrence != null) {
                occurrence.addB(y, y + FINE_LIMIT);
                if (contextWork[0] > 0) {
                    Anchor extended = extend(a, startA, endA, occurrence.startA, b, startB, endB, y, contextWork, budget);
                    if (strongest == null || extended.endA - extended.startA > strongest.endA - strongest.startA) strongest = extended;
                }
            }
        }
        List<Anchor> unique = anchors(matches, false, budget);
        // With repeated paragraphs or large repeated moved blocks, uniqueness
        // may not exist. First occurrences provide deterministic exact anchors;
        // surrounding prefix/suffix scans extend their common runs.
        if (!unique.isEmpty()) return unique;
        List<Anchor> representatives = anchors(matches, true, budget);
        if (strongest == null) return representatives;
        List<Anchor> ordered = new ArrayList<>();
        for (Anchor anchor : representatives) if (anchor.endA <= strongest.startA && anchor.endB <= strongest.startB) ordered.add(anchor);
        ordered.add(strongest);
        for (Anchor anchor : representatives) if (anchor.startA >= strongest.endA && anchor.startB >= strongest.endB) ordered.add(anchor);
        return ordered;
    }

    private static Anchor extend(int[] a, int startA, int endA, int x, int[] b, int startB, int endB, int y,
                                 long[] remaining, Budget budget) {
        int ax = x + FINE_LIMIT, by = y + FINE_LIMIT;
        while (x > startA && y > startB && remaining[0] > 0) {
            remaining[0]--; budget.step();
            if (a[x - 1] != b[y - 1]) break;
            x--; y--;
        }
        while (ax < endA && by < endB && remaining[0] > 0) {
            remaining[0]--; budget.step();
            if (a[ax] != b[by]) break;
            ax++; by++;
        }
        return new Anchor(x, ax, y, by);
    }

    private static List<Anchor> anchors(Map<Block, Occurrence> matches, boolean representatives, Budget budget) {
        List<Anchor> candidates = new ArrayList<>();
        for (var entry : matches.entrySet()) {
            Occurrence occurrence = entry.getValue();
            if (entry.getKey().end - entry.getKey().start >= MIN_ANCHOR && occurrence.countB > 0
                    && (representatives || occurrence.countA == 1 && occurrence.countB == 1)) {
                candidates.add(new Anchor(occurrence.startA, occurrence.endA, occurrence.startB, occurrence.endB));
            }
        }
        candidates.sort(Comparator.comparingInt(Anchor::startA));
        if (candidates.isEmpty()) return List.of();
        int[] tails = new int[candidates.size()], previous = new int[candidates.size()];
        int length = 0;
        for (int i = 0; i < candidates.size(); i++) {
            Anchor candidate = candidates.get(i);
            int low = 0, high = length;
            while (low < high) {
                budget.step(); int middle = (low + high) >>> 1;
                if (candidates.get(tails[middle]).endB <= candidate.startB) low = middle + 1;
                else high = middle;
            }
            previous[i] = low == 0 ? -1 : tails[low - 1];
            if (low == length || candidate.endB < candidates.get(tails[low]).endB) {
                tails[low] = i; if (low == length) length++;
            }
        }
        Anchor[] sequence = new Anchor[length];
        for (int at = tails[length - 1], i = length - 1; i >= 0; i--, at = previous[at]) sequence[i] = candidates.get(at);
        return Arrays.asList(sequence);
    }

    private static final class Occurrence {
        private final int startA, endA;
        private int startB, endB, countA, countB;
        private Occurrence(int startA, int endA) { this.startA = startA; this.endA = endA; }
        private void addB(int start, int end) { if (countB++ == 0) { startB = start; endB = end; } }
    }

    /** Hashes are only an index: equality always compares the original tokens. */
    private static final class Block implements Comparable<Block> {
        private final int[] values;
        private final int start, end, hash;
        private Block(int[] values, int start, int end) {
            this(values, start, end, hash(values, start, end));
        }
        private Block(int[] values, int start, int end, int hash) {
            this.values = values; this.start = start; this.end = end; this.hash = hash;
        }
        private static int hash(int[] values, int start, int end) {
            int hash = 0;
            for (int i = start; i < end; i++) hash = 31 * hash + values[i];
            return hash;
        }
        @Override public int hashCode() { return hash; }
        @Override public boolean equals(Object other) {
            return other instanceof Block block && hash == block.hash
                    && Arrays.equals(values, start, end, block.values, block.start, block.end);
        }
        @Override public int compareTo(Block block) {
            return Arrays.compare(values, start, end, block.values, block.start, block.end);
        }
    }

    private static Split bisect(int[] a, int startA, int endA, int[] b, int startB, int endB, Budget budget) {
        int n = endA - startA, m = endB - startB, maxD = (n + m + 1) / 2;
        budget.spend((long) n + m); // Linear frontier allocation/initialization also consumes work.
        int offset = maxD + 1, length = 2 * maxD + 3;
        int[] front = new int[length], reverse = new int[length];
        Arrays.fill(front, -1); Arrays.fill(reverse, -1);
        front[offset + 1] = 0; reverse[offset + 1] = 0;
        int delta = n - m;
        boolean odd = delta % 2 != 0;
        int frontStart = 0, frontEnd = 0, reverseStart = 0, reverseEnd = 0;
        for (int d = 0; d < maxD; d++) {
            for (int k = -d + frontStart; k <= d - frontEnd; k += 2) {
                budget.step();
                int at = offset + k;
                int x = k == -d || (k != d && front[at - 1] < front[at + 1]) ? front[at + 1] : front[at - 1] + 1;
                int y = x - k;
                while (x < n && y < m && a[startA + x] == b[startB + y]) { budget.step(); x++; y++; }
                front[at] = x;
                if (x > n) frontEnd += 2;
                else if (y > m) frontStart += 2;
                else if (odd) {
                    int opposite = offset + delta - k;
                    if (opposite >= 0 && opposite < length && reverse[opposite] != -1 && x >= n - reverse[opposite]) {
                        return new Split(startA + x, startB + y);
                    }
                }
            }
            for (int k = -d + reverseStart; k <= d - reverseEnd; k += 2) {
                budget.step();
                int at = offset + k;
                int x = k == -d || (k != d && reverse[at - 1] < reverse[at + 1]) ? reverse[at + 1] : reverse[at - 1] + 1;
                int y = x - k;
                while (x < n && y < m && a[endA - x - 1] == b[endB - y - 1]) { budget.step(); x++; y++; }
                reverse[at] = x;
                if (x > n) reverseEnd += 2;
                else if (y > m) reverseStart += 2;
                else if (!odd) {
                    int opposite = offset + delta - k;
                    if (opposite >= 0 && opposite < length && front[opposite] != -1 && front[opposite] >= n - x) {
                        int forwardX = front[opposite], forwardY = forwardX - (delta - k);
                        return new Split(startA + forwardX, startB + forwardY);
                    }
                }
            }
        }
        return null;
    }

    private static Document document(Delta delta, Map<JsonNode, Integer> embeds) {
        Objects.requireNonNull(delta, "document 不能为空");
        List<Op> ops = delta.getOps();
        int length = 0;
        for (Op op : ops) {
            if (!op.isInsert()) throw new IllegalArgumentException("Diff 输入必须是完整正文");
            length = Math.addExact(length, op.length());
        }
        int[] tokens = new int[length], offsets = new int[Math.addExact(length, 1)];
        int position = 0;
        for (Op op : ops) {
            if (op.isTextInsert()) {
                String text = op.text();
                for (int i = 0; i < text.length(); i++) tokens[position++] = text.charAt(i);
            } else tokens[position++] = embeds.computeIfAbsent(op.getInsert(), ignored -> FIRST_EMBED + embeds.size());
        }
        int size = 0;
        for (int i = 0; i < length;) {
            offsets[size] = i;
            int token = tokens[i++];
            if (token <= Character.MAX_VALUE && Character.isHighSurrogate((char) token) && i < length
                    && tokens[i] <= Character.MAX_VALUE && Character.isLowSurrogate((char) tokens[i])) {
                token = Character.toCodePoint((char) token, (char) tokens[i++]);
            }
            tokens[size++] = token;
        }
        offsets[size] = length;
        return new Document(ops, tokens, offsets, size);
    }

    private static Delta operation(Document a, Document b, List<Span> spans) {
        OpIterator old = new OpIterator(a.ops), next = new OpIterator(b.ops);
        Delta result = new Delta();
        int x = 0, y = 0;
        for (Span span : spans) {
            int count = span.length;
            if (span.kind == Kind.DELETE) {
                int length = a.offsets[x + count] - a.offsets[x]; x += count;
                consume(old, length); result.delete(length); checkOperationLowerBound(result);
            } else if (span.kind == Kind.INSERT) {
                int length = b.offsets[y + count] - b.offsets[y]; y += count;
                while (length > 0) {
                    Op part = next.next(length); result.push(part); checkOperationLowerBound(result); length -= part.length();
                }
            } else {
                int start = a.offsets[x], length = a.offsets[x + count] - start;
                x += count; y += count;
                equal(a, b, old, next, result, start, length);
            }
        }
        return result.chop();
    }

    private static void equal(Document a, Document b, OpIterator old, OpIterator next,
                              Delta result, int start, int length) {
        // Preserve the TARGET's original run boundaries before comparing it
        // against old formatting. Rebuilding these from the aligned slices
        // would retain every old boundary and concatenate the same target run
        // once per old slice during a literal-null replacement.
        List<Op> targetRuns = new ArrayList<>();
        for (int remaining = length; remaining > 0;) {
            Op run = next.next(remaining); targetRuns.add(run); remaining -= run.length();
        }
        OpIterator comparison = new OpIterator(targetRuns);
        List<Op> before = new ArrayList<>(), after = new ArrayList<>();
        List<Range> replacements = new ArrayList<>();
        int position = 0;
        while (position < length) {
            int take = Math.min(length - position, Math.min(old.peekLength(), comparison.peekLength()));
            Op left = old.next(take), right = comparison.next(take);
            before.add(left); after.add(right);
            if (requiresLiteralNull(left.getAttributes(), right.getAttributes())) {
                // Existing formatting runs can split a UTF-16 surrogate pair.
                // Expand a necessary replacement to code-point boundaries;
                // never replace one half while leaving its old partner behind.
                int begin = boundary(a, start + position, false) - start;
                int end = boundary(a, start + position + take, true) - start;
                if (start + end == a.offsets[a.size] && a.size > 0 && b.size > 0
                        && a.tokens[a.size - 1] == '\n' && b.tokens[b.size - 1] == '\n') {
                    throw new TerminalNewlineAttributeException();
                }
                if (!replacements.isEmpty() && replacements.getLast().end >= begin) {
                    Range previous = replacements.removeLast();
                    begin = previous.begin; end = Math.max(end, previous.end);
                }
                replacements.add(new Range(begin, end));
            }
            position += take;
        }
        if (replacements.isEmpty()) {
            for (int i = 0; i < before.size(); i++) {
                result.retain(before.get(i).length(), attributes(before.get(i).getAttributes(), after.get(i).getAttributes()));
                checkOperationLowerBound(result);
            }
            return;
        }
        OpIterator left = new OpIterator(before), right = new OpIterator(targetRuns);
        int rangeIndex = 0;
        position = 0;
        while (position < length) {
            while (rangeIndex < replacements.size() && position >= replacements.get(rangeIndex).end) rangeIndex++;
            Range range = rangeIndex < replacements.size() ? replacements.get(rangeIndex) : null;
            boolean replace = range != null && position >= range.begin;
            int boundary = range == null ? length : replace ? range.end : range.begin;
            int take = Math.min(boundary - position, right.peekLength());
            if (replace) {
                // Old formatting boundaries do not split a replacement insert;
                // consume them without repeatedly concatenating its target text.
                consume(left, take); result.push(right.next(take)); result.delete(take);
            } else {
                take = Math.min(take, left.peekLength());
                Op oldPart = left.next(take), newPart = right.next(take);
                result.retain(take, attributes(oldPart.getAttributes(), newPart.getAttributes()));
            }
            checkOperationLowerBound(result);
            position += take;
        }
    }

    private static int boundary(Document document, int utf16Position, boolean forward) {
        int index = Arrays.binarySearch(document.offsets, 0, document.size + 1, utf16Position);
        if (index >= 0) return utf16Position;
        int insertion = -index - 1;
        return document.offsets[forward ? insertion : insertion - 1];
    }

    private static boolean requiresLiteralNull(Map<String, Object> before, Map<String, Object> after) {
        if (after == null) return false;
        for (var attribute : after.entrySet()) {
            if (attribute.getValue() == null && (before == null || !before.containsKey(attribute.getKey())
                    || before.get(attribute.getKey()) != null)) return true;
        }
        return false;
    }

    private static void checkOperationLowerBound(Delta operation) {
        // Every valid Op needs at least 12 JSON bytes; separators and {"ops":[]}
        // yield 13*N+9. push() never decreases normalized operationCount(), but
        // chop() may remove ONE final plain retain. Allow that row before using
        // the strict bound, so a near-limit valid operation is never rejected.
        long definiteRows = Math.max(0, operation.operationCount() - 1);
        if (13L * definiteRows + 9 > 4L * 1024 * 1024) throw new OperationSizeLimitException();
    }

    private static void consume(OpIterator iterator, int length) {
        while (length > 0) length -= iterator.next(length).length();
    }

    private static Map<String, Object> attributes(Map<String, Object> before, Map<String, Object> after) {
        Map<String, Object> result = new LinkedHashMap<>();
        if (after != null) after.forEach((key, value) -> {
            if (before == null || !before.containsKey(key) || !Objects.equals(before.get(key), value)) result.put(key, value);
        });
        if (before != null) before.keySet().forEach(key -> { if (after == null || !after.containsKey(key)) result.put(key, null); });
        return result.isEmpty() ? null : result;
    }

    private static void append(List<Span> spans, Kind kind, int length) {
        if (length == 0) return;
        // Apply the same insert-before-delete normalization as Delta.push,
        // before materializing strings. Otherwise many adjacent replaced fine
        // blocks would concatenate an ever-growing insert once per block.
        if (kind == Kind.INSERT && !spans.isEmpty() && spans.getLast().kind == Kind.DELETE) {
            int index = spans.size() - 1;
            if (index > 0 && spans.get(index - 1).kind == Kind.INSERT) {
                Span previous = spans.get(index - 1);
                spans.set(index - 1, new Span(kind, Math.addExact(previous.length, length)));
            } else spans.add(index, new Span(kind, length));
            return;
        }
        if (!spans.isEmpty() && spans.getLast().kind == kind) {
            Span last = spans.removeLast(); length = Math.addExact(length, last.length);
        }
        spans.add(new Span(kind, length));
    }

    private enum Kind { DIFF, EQUAL, INSERT, DELETE }
    private record Task(Kind kind, int startA, int endA, int startB, int endB, int level) {
        private Task(Kind kind, int startA, int endA, int startB, int endB) {
            this(kind, startA, endA, startB, endB, 0);
        }
    }
    private record Split(int x, int y) { }
    private record Anchor(int startA, int endA, int startB, int endB) { }
    private record Span(Kind kind, int length) { }
    private record Range(int begin, int end) { }
    private record Document(List<Op> ops, int[] tokens, int[] offsets, int size) { }
}
