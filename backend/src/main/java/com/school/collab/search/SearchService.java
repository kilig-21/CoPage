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
        List<HitView> hits = matches.ids().stream()
                .map(id -> documents.find(id).orElse(null))
                .filter(row -> row != null && (row.ownerId() == userId
                        || documents.collaboratorPermission(row.id(), userId) > 0))
                .map(row -> view(row, literal))
                .toList();
        return new SearchView(matches.total(), hits);
    }

    private static HitView view(DocumentRow row, Pattern literal) {
        String body = SearchIndex.plainText(row.content());
        String excerpt = literal.matcher(body).find() ? body : row.title();
        return new HitView(row.id(), row.title(), highlight(excerpt, literal),
                row.updateTime().format(TIME));
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

    public record HitView(long id, String title, String snippet, String updateTime) {
    }

    public record SearchView(long total, List<HitView> list) {
    }
}
