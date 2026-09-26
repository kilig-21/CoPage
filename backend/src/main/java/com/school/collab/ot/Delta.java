package com.school.collab.ot;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;

public final class Delta {

    @JsonProperty("ops")
    private final List<Op> ops;

    public Delta() {
        this(null);
    }

    @JsonCreator
    public Delta(@JsonProperty("ops") List<Op> ops) {
        this.ops = new ArrayList<>();
        if (ops != null) {
            ops.forEach(this::push);
        }
    }

    /**
    *方便调用的"快捷方法"
    * */
    public Delta insert(String text) {
        return push(Op.insert(text));
    }
    public Delta insert(String text, Map<String, Object> attributes) {
        return push(Op.insert(text, attributes));
    }
    public Delta retain(int length) {
        return push(Op.retain(length));
    }
    public Delta retain(int length, Map<String, Object> attributes) {
        return push(Op.retain(length, attributes));
    }
    public Delta delete(int length) {
        return push(Op.delete(length));
    }

    /**
     * 规范化入口：
     * 1. 相邻 delete 合并；
     * 2. 相邻且 attributes 相同的文本 insert 合并；
     * 3. 相邻且 attributes 相同的 retain 合并；
     * 4. 同一位置的 insert 必须排在 delete 前。
     */
    public Delta push(Op newOp) {
        Objects.requireNonNull(newOp, "Op 不能为空");
        Op incoming = newOp.copy();
        incoming.kind();

        if (ops.isEmpty()) {
            ops.add(incoming);
            return this;
        }

        int index = ops.size();
        Op last = ops.get(index - 1);

        if (incoming.isDelete() && last.isDelete()) {
            ops.set(index - 1, Op.delete(Math.addExact(last.length(), incoming.length())));
            return this;
        }

        // insert 与 delete 位于同一位置时，统一采用 insert 在前的标准顺序。
        if (last.isDelete() && incoming.isInsert()) {
            index--;
            if (index == 0) {
                ops.add(0, incoming);
                return this;
            }
            last = ops.get(index - 1);
        }

        if (Objects.equals(last.getAttributes(), incoming.getAttributes())) {
            if (last.isTextInsert() && incoming.isTextInsert()) {
                ops.set(index - 1, Op.insert(last.text() + incoming.text(), incoming.getAttributes()));
                return this;
            }

            if (last.isRetain() && incoming.isRetain()) {
                ops.set(index - 1, Op.retain(Math.addExact(last.length(), incoming.length()), incoming.getAttributes()));
                return this;
            }
        }

        if (index == ops.size()) {
            ops.add(incoming);
        } else {
            ops.add(index, incoming);
        }
        return this;
    }

    /**
     * 末尾无 attributes 的 retain 不改变文档，可省略。
     */
    public Delta chop() {
        if (!ops.isEmpty()) {
            Op last = ops.getLast();
            if (last.isRetain() && last.getAttributes() == null) {
                ops.removeLast();
            }
        }
        return this;
    }

    /** 操作覆盖的基准长度。 */
    public int length() {
        return ops.stream().mapToInt(Op::length).sum();
    }

    /** 本次编辑对文档总长度的净变化。 */
    public int changeLength() {
        return ops.stream().mapToInt(op -> {
            if (op.isInsert()) return op.length();
            if (op.isDelete()) return -op.length();
            return 0;
        }).sum();
    }

    /**
    * 创建一个 Delta 副本
    * */
    public Delta copy() {
        return new Delta(ops);
    }

    /**
    * 返回一份 Op 的副本列表
    * */
    public List<Op> getOps() {
        return ops.stream().map(Op::copy).toList();
    }
}
