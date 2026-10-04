package com.school.collab.document;

import com.fasterxml.jackson.databind.JsonNode;
import java.net.URI;
import java.util.Locale;
import java.util.Set;

/** 文档产品的格式边界；OT算法本身仍支持通用Delta。 */
public final class DocumentFormats {
    private DocumentFormats() { }
    private static final Set<String> FORMATS = Set.of("bold", "italic", "underline", "strike", "blockquote",
            "code", "code-block", "header", "list", "indent", "align", "direction", "font", "size",
            "color", "background", "link", "script", "alt", "width", "height");

    public static boolean safeUrl(String value, boolean image) {
        if (value.length() > 2048 || value.chars().anyMatch(c -> c < 32 || c == 127)) return false;
        try {
            URI uri = URI.create(value);
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            if (scheme.equals("http") || scheme.equals("https")) return uri.getHost() != null && uri.getUserInfo() == null;
            return !image && (scheme.equals("mailto") || scheme.equals("tel"));
        } catch (IllegalArgumentException ex) { return false; }
    }
    public static boolean validAttribute(String key, JsonNode value) {
        if (!FORMATS.contains(key)) return false;
        return switch (key) {
            case "bold", "italic", "underline", "strike", "blockquote", "code" -> value.isBoolean();
            case "header" -> value.isIntegralNumber() && value.canConvertToInt() && value.asInt() >= 1 && value.asInt() <= 6;
            case "indent" -> value.isIntegralNumber() && value.canConvertToInt() && value.asInt() >= 0 && value.asInt() <= 8;
            case "link" -> value.isTextual() && safeUrl(value.asText(), false);
            case "list" -> value.isTextual() && Set.of("ordered", "bullet", "checked", "unchecked").contains(value.asText());
            case "align" -> value.isTextual() && Set.of("left", "center", "right", "justify").contains(value.asText());
            case "direction" -> value.isTextual() && "rtl".equals(value.asText());
            case "font" -> value.isTextual() && Set.of("serif", "monospace").contains(value.asText());
            case "size" -> value.isTextual() && Set.of("small", "large", "huge").contains(value.asText());
            case "script" -> value.isTextual() && Set.of("sub", "super").contains(value.asText());
            case "alt" -> value.isTextual() && value.asText().length() <= 512
                    && value.asText().chars().noneMatch(c -> c < 32 || c == 127);
            case "width", "height" -> value.isTextual()
                    && value.asText().matches("[1-9][0-9]{0,3}|10000|(?:[1-9][0-9]?|100)%");
            case "code-block" -> value.isBoolean() || (value.isTextual() && value.asText().matches("[a-zA-Z0-9_-]{1,64}"));
            case "color", "background" -> value.isTextual() && value.asText().matches("#[a-fA-F0-9]{3,8}|[a-zA-Z]{1,20}|rgba?\\([0-9., %]{1,40}\\)");
            default -> false;
        };
    }

    public static void validateEditorOperation(JsonNode operation) {
        if (!operation.isObject() || operation.size() != 1 || !operation.path("ops").isArray()
                || operation.path("ops").isEmpty() || operation.path("ops").size() > 10000) {
            throw invalid();
        }
        for (JsonNode op : operation.path("ops")) {
            if (!op.isObject()) throw invalid();
            int count = (op.has("insert") ? 1 : 0) + (op.has("retain") ? 1 : 0) + (op.has("delete") ? 1 : 0);
            if (count != 1 || op.size() != (op.has("attributes") ? 2 : 1)) throw invalid();
            if (op.has("insert")) {
                JsonNode value = op.path("insert");
                if (value.isTextual()) {
                    if (value.asText().isEmpty() || value.asText().indexOf('\0') >= 0) throw invalid();
                } else if (!value.isObject() || value.size() != 1 || !value.path("image").isTextual()
                        || !safeUrl(value.path("image").asText(), true)) throw invalid();
            } else {
                JsonNode length = op.get(op.has("retain") ? "retain" : "delete");
                if (!length.isIntegralNumber() || !length.canConvertToInt() || length.asInt() <= 0) throw invalid();
            }
            JsonNode attributes = op.get("attributes");
            if (attributes == null) continue;
            if (!attributes.isObject() || op.has("delete")) throw invalid();
            attributes.fields().forEachRemaining(entry -> {
                boolean removal = op.has("retain") && entry.getValue().isNull() && FORMATS.contains(entry.getKey());
                if (!removal && !validAttribute(entry.getKey(), entry.getValue())) throw invalid();
            });
        }
    }

    private static IllegalArgumentException invalid() {
        return new IllegalArgumentException("编辑只支持文字、HTTP(S)图片和支持的格式属性");
    }
}
