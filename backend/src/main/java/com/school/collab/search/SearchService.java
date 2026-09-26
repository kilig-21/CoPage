package com.school.collab.search;

import com.school.collab.common.BizException;
import com.school.collab.common.ErrorCode;
import com.school.collab.common.UserContext;
import com.school.collab.document.DocumentRepository;
import com.school.collab.document.DocumentRepository.DocumentRow;
import org.springframework.stereotype.Service;

import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Locale;

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
        List<HitView> hits = matches.ids().stream()
                .map(id -> documents.find(id).orElse(null))
                .filter(row -> row != null && (row.ownerId() == userId
                        || documents.collaboratorPermission(row.id(), userId) > 0))
                .map(row -> view(row, q))
                .toList();
        return new SearchView(matches.total(), hits);
    }

    private static HitView view(DocumentRow row, String q) {
        String body = SearchIndex.plainText(row.content());
        String excerpt = body.toLowerCase(Locale.ROOT).contains(q.toLowerCase(Locale.ROOT))
                ? body : row.title();
        return new HitView(row.id(), row.title(), highlight(excerpt, q),
                row.updateTime().format(TIME));
    }

    /** 只保留服务端生成的 strong 标记；原文中的 HTML 全部转义。 */
    static String highlight(String text, String query) {
        int match = text.toLowerCase(Locale.ROOT).indexOf(query.toLowerCase(Locale.ROOT));
        if (match < 0) return escape(text.substring(0, Math.min(160, text.length())));
        int start = Math.max(0, match - 60);
        int end = Math.min(text.length(), match + query.length() + 80);
        return (start > 0 ? "…" : "") + escape(text.substring(start, match))
                + "<strong>" + escape(text.substring(match, match + query.length())) + "</strong>"
                + escape(text.substring(match + query.length(), end))
                + (end < text.length() ? "…" : "");
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
