package com.school.collab.document;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.common.BizException;
import com.school.collab.common.ErrorCode;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Set;

/** 有界的 UTF-8 文本与 CoPage 富文本副本；副本不包含身份、权限、草稿或历史。 */
@Service
public class DocumentTransfer {
    public static final int MAX_BYTES = 1024 * 1024;
    private static final Set<String> FORMATS = Set.of("bold", "italic", "underline", "strike", "blockquote",
            "code", "code-block", "header", "list", "indent", "align", "direction", "font", "size",
            "color", "background", "link", "script");
    private final DocumentService documents;
    private final ObjectMapper mapper;
    public DocumentTransfer(DocumentService documents, ObjectMapper mapper) { this.documents = documents; this.mapper = mapper; }

    public DocumentService.SummaryView importFile(MultipartFile file, String title) {
        if (file.isEmpty() || file.getSize() > MAX_BYTES) throw invalid("请选择不超过 1 MiB 的非空文件");
        String filename = file.getOriginalFilename() == null ? "" : file.getOriginalFilename();
        String lower = filename.toLowerCase(Locale.ROOT);
        try {
            byte[] bytes = file.getBytes();
            if (bytes.length > MAX_BYTES) throw invalid("文件不能超过 1 MiB");
            String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
            if (text.startsWith("\uFEFF")) text = text.substring(1);
            JsonNode content;
            String suggested;
            if (lower.endsWith(".txt")) {
                text = text.replace("\r\n", "\n").replace('\r', '\n');
                if (text.indexOf('\0') >= 0) throw invalid("文本包含不支持的空字符");
                if (!text.endsWith("\n")) text += "\n";
                content = mapper.createObjectNode().set("ops", mapper.createArrayNode().add(mapper.createObjectNode().put("insert", text)));
                suggested = filename.substring(0, filename.length() - 4);
            } else if (lower.endsWith(".json")) {
                JsonNode copy = mapper.reader().with(com.fasterxml.jackson.databind.DeserializationFeature.FAIL_ON_TRAILING_TOKENS).readTree(text);
                if (copy == null || !"copage".equals(copy.path("format").asText()) || !copy.path("version").isIntegralNumber()
                        || !copy.path("version").canConvertToInt() || copy.path("version").asInt() != 1) throw invalid("请选择 CoPage 导出的版本 1 副本");
                content = validateContent(copy.path("content"));
                suggested = copy.path("title").isTextual() ? copy.path("title").asText() : "导入的文档";
            } else throw invalid("只支持 UTF-8 .txt 和 CoPage .json 副本");
            content = validateContent(content);
            String finalTitle = title == null || title.isBlank() ? suggested : title;
            if (finalTitle.length() > 200) throw invalid("标题最多 200 字符，请修改后重试");
            return documents.createImported(finalTitle, content);
        } catch (IOException exception) { throw invalid("文件无法读取，请使用 UTF-8 文本或有效的 CoPage 副本"); }
    }

    public ExportView export(long docId, String format) {
        var doc = documents.detail(docId); // 与每次查看相同的权限及删除状态检查。
        String filename = safeFilename(doc.title());
        if ("txt".equals(format)) {
            StringBuilder text = new StringBuilder();
            for (JsonNode op : doc.content().path("ops")) {
                JsonNode insert = op.path("insert");
                if (insert.isTextual()) text.append(insert.asText());
                else if (insert.path("image").isTextual()) text.append("[图片：").append(insert.path("image").asText()).append(']');
            }
            return bounded(filename + ".txt", "text/plain;charset=utf-8", text.toString(), doc.revision());
        }
        if ("copage".equals(format)) {
            JsonNode content = validateContent(doc.content());
            var copy = mapper.createObjectNode().put("format", "copage").put("version", 1).put("title", doc.title());
            copy.set("content", content);
            return bounded(filename + ".copage.json", "application/json;charset=utf-8", copy.toString(), doc.revision());
        }
        throw invalid("不支持的导出格式");
    }

    private ExportView bounded(String filename, String mediaType, String content, long revision) {
        if (content.getBytes(StandardCharsets.UTF_8).length > MAX_BYTES) throw invalid("副本超过 1 MiB，请缩小内容后导出");
        return new ExportView(filename, mediaType, content, revision);
    }

    JsonNode validateContent(JsonNode content) {
        if (!content.isObject() || content.size() != 1 || !content.path("ops").isArray()
                || content.path("ops").isEmpty() || content.path("ops").size() > 10000) throw invalid("副本正文结构不受支持");
        for (JsonNode op : content.path("ops")) {
            if (!op.isObject() || !op.has("insert") || op.size() > (op.has("attributes") ? 2 : 1)) throw invalid("副本必须是完整正文，不能是编辑操作");
            JsonNode insert = op.path("insert");
            if (insert.isTextual()) {
                if (insert.asText().isEmpty() || insert.asText().indexOf('\0') >= 0) throw invalid("副本包含空文本或不支持的字符");
            } else if (!insert.isObject() || insert.size() != 1 || !insert.path("image").isTextual() || !safeUrl(insert.path("image").asText(), true)) {
                throw invalid("副本只支持文字和 HTTP(S) 图片地址");
            }
            JsonNode attributes = op.get("attributes");
            if (attributes != null) {
                if (!attributes.isObject()) throw invalid("格式属性必须是对象");
                attributes.fields().forEachRemaining(entry -> {
                    JsonNode value = entry.getValue();
                    if (!FORMATS.contains(entry.getKey()) || !validAttribute(entry.getKey(), value)) throw invalid("副本包含不支持的格式或链接");
                });
            }
        }
        JsonNode last = content.path("ops").get(content.path("ops").size() - 1).path("insert");
        if (!last.isTextual() || !last.asText().endsWith("\n")) throw invalid("副本正文必须以换行结束");
        if (content.toString().getBytes(StandardCharsets.UTF_8).length > MAX_BYTES) throw invalid("副本正文超过 1 MiB");
        // 线性合并同格式文本，避免大量拆碎的文本在后续 Delta.push 中反复复制长字符串。
        var normalized = mapper.createArrayNode();
        com.fasterxml.jackson.databind.node.ObjectNode pending = null;
        StringBuilder text = null;
        for (JsonNode op : content.path("ops")) {
            if (op.path("insert").isTextual() && pending != null && java.util.Objects.equals(pending.get("attributes"), op.get("attributes"))) {
                text.append(op.path("insert").asText());
                continue;
            }
            if (pending != null) { pending.put("insert", text.toString()); normalized.add(pending); pending = null; }
            if (op.path("insert").isTextual()) { pending = op.deepCopy(); text = new StringBuilder(op.path("insert").asText()); }
            else normalized.add(op.deepCopy());
        }
        if (pending != null) { pending.put("insert", text.toString()); normalized.add(pending); }
        return mapper.createObjectNode().set("ops", normalized);
    }

    private static boolean safeUrl(String value, boolean image) {
        if (value.length() > 2048 || value.chars().anyMatch(c -> c < 32 || c == 127)) return false;
        try {
            URI uri = URI.create(value);
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            if (scheme.equals("http") || scheme.equals("https")) return uri.getHost() != null && uri.getUserInfo() == null;
            return !image && (scheme.equals("mailto") || scheme.equals("tel"));
        } catch (IllegalArgumentException ex) { return false; }
    }
    private static boolean validAttribute(String key, JsonNode value) {
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
            case "code-block" -> value.isBoolean() || (value.isTextual() && value.asText().matches("[a-zA-Z0-9_-]{1,64}"));
            case "color", "background" -> value.isTextual() && value.asText().matches("#[a-fA-F0-9]{3,8}|[a-zA-Z]{1,20}|rgba?\\([0-9., %]{1,40}\\)");
            default -> false;
        };
    }
    private static String safeFilename(String title) {
        String clean = title.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim().replaceAll("[. ]+$", "");
        if (clean.isEmpty()) clean = "文档";
        return clean.substring(0, Math.min(clean.length(), 100));
    }
    private static BizException invalid(String message) { return new BizException(ErrorCode.PARAM_ERROR, message); }
    public record ExportView(String filename, String mediaType, String content, long revision) { }
}
