package com.school.collab.search;

import com.school.collab.common.BizException;
import com.school.collab.common.ErrorCode;
import com.school.collab.common.UserContext;
import com.school.collab.document.DocumentRepository;
import com.school.collab.document.DocumentRepository.DocumentRow;
import org.springframework.stereotype.Service;

import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

@Service
public class SearchService {
    private static final DateTimeFormatter TIME = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");
    private final SearchIndex index;
    private final DocumentRepository documents;

    public SearchService(SearchIndex index, DocumentRepository documents) {
        this.index = index;
        this.documents = documents;
    }

    public SearchView search(String query, int page, int size) {
        Long userId = UserContext.getUserId();
        if (userId == null) throw new BizException(ErrorCode.UNAUTHORIZED);
        String q = query == null ? "" : query.trim();
        if (q.isEmpty() || q.length() > 100 || page < 1 || size < 1 || size > 100
                || ((long) page - 1) * size >= 10_000) {
            throw new BizException(ErrorCode.PARAM_ERROR);
        }
        List<Long> visible = documents.visibleIds(userId);
        SearchIndex.SearchPage matches = index.search(q, visible, page, size);
        Pattern literal = literalPattern(q);
        List<HitView> hits = new java.util.ArrayList<>();
        for (long id : matches.ids()) {
            DocumentRow row = documents.find(id).orElse(null);
            if (row == null) continue;
            boolean isOwner = row.ownerId() == userId;
            int permission = isOwner ? 2 : documents.collaboratorPermission(row.id(), userId);
            if (permission != 1 && permission != 2) continue;
            hits.add(view(row, literal, permission, isOwner));
        }
        return new SearchView(matches.total(), hits);
    }

    private static HitView view(DocumentRow row, Pattern literal, int permission, boolean isOwner) {
        String body = SearchIndex.plainText(row.content());
        String snippet = literal.matcher(body).find() ? highlight(body, literal) : opening(body);
        if (snippet == null) snippet = literal.matcher(row.title()).find()
                ? "标题匹配，暂无文字摘要" : "暂无文字摘要";
        return new HitView(row.id(), row.title(), snippet,
                row.updateTime().format(TIME), row.ownerId(), row.ownerName(), permission, isOwner);
    }

    /** 无字面命中时只预览当前正文开头；忽略空行，不把图片地址当作文字。 */
    private static String opening(String text) {
        int start = 0, limit = text.length();
        while (start < limit && previewSpace(text.codePointAt(start))) start += Character.charCount(text.codePointAt(start));
        if (start == limit) return null;
        while (limit > start && previewSpace(text.codePointBefore(limit))) limit -= Character.charCount(text.codePointBefore(limit));
        int end = sliceEnd(text, start + Math.min(160, limit - start));
        return escape(text.substring(start, end)) + (end < limit ? "…" : "");
    }

    private static boolean previewSpace(int codePoint) {
        return Character.isWhitespace(codePoint) || Character.isSpaceChar(codePoint);
    }

    /** 只保留服务端生成的 strong 标记；原文中的 HTML 全部转义。 */
    static String highlight(String text, String query) {
        return highlight(text, literalPattern(query));
    }

    private static Pattern literalPattern(String query) {
        // 只作字面匹配；匹配坐标来自原文，不使用可能变长的小写副本坐标。
        return Pattern.compile(Pattern.quote(query), Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);
    }

    private static String highlight(String text, Pattern literal) {
        Matcher match = literal.matcher(text);
        if (!match.find()) return escape(text.substring(0, sliceEnd(text, Math.min(160, text.length()))));
        int start = sliceStart(text, Math.max(0, match.start() - 60));
        int end = sliceEnd(text, Math.min(text.length(), match.end() + 80));
        return (start > 0 ? "…" : "") + escape(text.substring(start, match.start()))
                + "<strong>" + escape(text.substring(match.start(), match.end())) + "</strong>"
                + escape(text.substring(match.end(), end))
                + (end < text.length() ? "…" : "");
    }

    private static boolean splitsSurrogatePair(String text, int offset) {
        return offset > 0 && offset < text.length() && Character.isLowSurrogate(text.charAt(offset))
                && Character.isHighSurrogate(text.charAt(offset - 1));
    }

    private static int sliceStart(String text, int offset) {
        return splitsSurrogatePair(text, offset) ? offset - 1 : offset;
    }

    private static int sliceEnd(String text, int offset) {
        return splitsSurrogatePair(text, offset) ? offset + 1 : offset;
    }

    private static String escape(String value) {
        return value.replace("&", "&amp;").replace("<", "&lt;")
                .replace(">", "&gt;").replace("\"", "&quot;").replace("'", "&#39;");
    }

    public record HitView(long id, String title, String snippet, String updateTime,
                          long ownerId, String ownerName, int permission, boolean isOwner) {
    }

    public record SearchView(long total, List<HitView> list) {
    }
}
