package com.school.collab.ot;

import java.util.List;
import java.util.NoSuchElementException;
import java.util.Objects;

public final class OpIterator {

    private final List<Op> ops;
    private int index;
    private int offset;

    public OpIterator(List<Op> ops) {
        this.ops = List.copyOf(Objects.requireNonNull(ops, "ops 不能为空"));
    }

    public boolean hasNext() {
        return index < ops.size();
    }

    public Op.Kind peekKind() {
        return hasNext() ? ops.get(index).kind() : Op.Kind.RETAIN;
    }

    public int peekLength() {
        return hasNext() ? ops.get(index).length() - offset : Integer.MAX_VALUE;
    }

    public Op next() {
        return next(peekLength());
    }

    /**
     * 取当前操作的前 requestedLength 个单位；不足时取剩余部分。
     * 原操作不会被修改，迭代器只移动自身游标。
     */
    public Op next(int requestedLength) {
        if (requestedLength <= 0) {
            throw new IllegalArgumentException("请求长度必须大于 0");
        }
        // Delta 省略末尾 retain；算法层将耗尽的序列视为无限 retain。
        if (!hasNext()) {
            return Op.retain(requestedLength);
        }

        Op current = ops.get(index);
        int available = current.length() - offset;
        int take = Math.min(requestedLength, available);
        Op result = slice(current, offset, take);

        if (take == available) {
            index++;
            offset = 0;
        } else {
            offset += take;
        }
        return result;
    }

    private Op slice(Op op, int start, int length) {
        return switch (op.kind()) {
            case RETAIN -> Op.retain(length, op.getAttributes());
            case DELETE -> Op.delete(length);
            case INSERT -> {
                if (op.isTextInsert()) {
                    String text = op.text();
                    yield Op.insert(text.substring(start, start + length), op.getAttributes());
                }

                // 图片等嵌入对象长度恒为 1，不能从中间切开。
                if (start != 0 || length != 1) {
                    throw new IllegalStateException("嵌入对象不能被部分切分");
                }
                yield Op.insertEmbed(op.getInsert(), op.getAttributes());
            }
        };
    }

    private void ensureHasNext() {
        if (!hasNext()) {
            throw new NoSuchElementException("没有更多操作可读取");
        }
    }
}
