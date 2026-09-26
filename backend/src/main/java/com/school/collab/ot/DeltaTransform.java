package com.school.collab.ot;

import java.util.Objects;

/**
 * Operational Transformation 的纯函数实现。
 *
 * <p>{@link #transform(Delta, Delta, boolean)} 返回 other 在 against 已先发生后的等价操作。</p>
 */
public final class DeltaTransform {

    private DeltaTransform() {
    }

    /**
     * 把 {@code other} 转换到 {@code against} 已执行后的坐标系。
     *
     * @param against 已先发生的并发操作
     * @param other 需要转换的并发操作
     * @param againstHasPriority 两人同一位置插入或改同一属性时，against 是否优先
     */
    public static Delta transform(Delta against, Delta other, boolean againstHasPriority) {
        Objects.requireNonNull(against, "against 不能为空");
        Objects.requireNonNull(other, "other 不能为空");

        OpIterator againstIterator = new OpIterator(against.getOps());
        OpIterator otherIterator = new OpIterator(other.getOps());
        Delta result = new Delta();

        while (againstIterator.hasNext() || otherIterator.hasNext()) {
            if (againstIterator.peekKind() == Op.Kind.INSERT
                    && (againstHasPriority || otherIterator.peekKind() != Op.Kind.INSERT)) {
                result.retain(againstIterator.next().length());
            } else if (otherIterator.peekKind() == Op.Kind.INSERT) {
                result.push(otherIterator.next());
            } else {
                int length = Math.min(againstIterator.peekLength(), otherIterator.peekLength());
                Op againstPart = againstIterator.next(length);
                Op otherPart = otherIterator.next(length);

                if (againstPart.isDelete()) {
                    // against 已删掉这段基准内容；other 的 retain/delete 都不再需要。
                    continue;
                }
                if (otherPart.isDelete()) {
                    result.push(otherPart);
                    continue;
                }

                // 两边此时都是 retain。属性冲突由 againstHasPriority 裁决。
                result.retain(
                        length,
                        AttributeMap.transform(
                                againstPart.getAttributes(),
                                otherPart.getAttributes(),
                                againstHasPriority
                        )
                );
            }
        }
        return result.chop();
    }

    /** 将一个光标/选区端点转换到 change 已执行后的坐标系。 */
    public static int transformPosition(Delta change, int index, boolean changeHasPriority) {
        Objects.requireNonNull(change, "change 不能为空");
        if (index < 0) {
            throw new IllegalArgumentException("光标位置不能小于 0");
        }

        OpIterator iterator = new OpIterator(change.getOps());
        int offset = 0;
        int transformed = index;

        while (iterator.hasNext() && offset <= transformed) {
            int length = iterator.peekLength();
            Op.Kind kind = iterator.peekKind();
            iterator.next();

            if (kind == Op.Kind.DELETE) {
                transformed -= Math.min(length, transformed - offset);
                // delete 不推进原文坐标；否则后续同位置 insert 会被错误跳过。
                continue;
            } else if (kind == Op.Kind.INSERT && (offset < transformed || !changeHasPriority)) {
                transformed += length;
            }
            offset += length;
        }
        return transformed;
    }
}
