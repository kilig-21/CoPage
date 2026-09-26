package com.school.collab.ot;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Quill Delta 属性的纯函数工具。
 *
 * <p>属性值为 {@code null} 表示移除该格式，例如 {@code {"bold": null}}。
 * 因此不能使用会丢弃 Map 中 null 值的拷贝方式。</p>
 */
public final class AttributeMap {

    private AttributeMap() {
    }

    /**
     * 将 change 叠加到 base。
     *
     * @param keepNull true 时保留 change 中的 null（用于 compose），false 时把 null 视为删除属性
     */
    public static Map<String, Object> compose(
            Map<String, Object> base,
            Map<String, Object> change,
            boolean keepNull
    ) {
        Map<String, Object> result = new LinkedHashMap<>();
        if (base != null) {
            result.putAll(base);
        }
        if (change != null) {
            change.forEach((key, value) -> {
                if (value == null && !keepNull) {
                    result.remove(key);
                } else {
                    result.put(key, value);
                }
            });
        }
        return result.isEmpty() ? null : result;
    }

    /**
     * 将 other 的格式变化转换到 base 已先发生之后。
     * 当 base 有优先级时，base 已修改的同名属性不再由 other 覆盖。
     */
    public static Map<String, Object> transform(
            Map<String, Object> base,
            Map<String, Object> other,
            boolean baseHasPriority
    ) {
        if (base == null || base.isEmpty()) {
            return copy(other);
        }
        if (other == null || other.isEmpty()) {
            return null;
        }
        if (!baseHasPriority) {
            return copy(other);
        }

        Map<String, Object> result = new LinkedHashMap<>();
        other.forEach((key, value) -> {
            // containsKey 很关键：{bold: null} 仍然代表一次有效格式变化。
            if (!base.containsKey(key)) {
                result.put(key, value);
            }
        });
        return result.isEmpty() ? null : result;
    }

    private static Map<String, Object> copy(Map<String, Object> source) {
        return source == null || source.isEmpty() ? null : new LinkedHashMap<>(source);
    }
}
