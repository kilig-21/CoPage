package com.school.collab.ot;

import java.util.Map;
import java.util.Objects;

/** Applies a change Delta to a document Delta without mutating either input. */
public final class DeltaApply {

    private DeltaApply() {
    }

    /**
     * 文档 Delta 只由 insert 组成；修改 Delta 由 retain / insert / delete 组成。
     * 修改没有覆盖到的尾部内容会原样保留。
     */
    public static Delta apply(Delta document, Delta change) {
        Objects.requireNonNull(document, "document 不能为空");
        Objects.requireNonNull(change, "change 不能为空");
        validateDocument(document);

        OpIterator source = new OpIterator(document.getOps());
        DocumentBuilder result = new DocumentBuilder();

        for (Op operation : change.getOps()) {
            switch (operation.kind()) {
                case INSERT -> result.append(operation);
                case RETAIN -> retain(source, result, operation.length(), operation.getAttributes());
                case DELETE -> discard(source, operation.length());
            }
        }

        while (source.hasNext()) {
            result.append(source.next());
        }
        return result.finish();
    }

    private static void retain(OpIterator source, DocumentBuilder result, int remaining, Map<String, Object> attributes) {
        while (remaining > 0) {
            Op part = nextDocumentPart(source, remaining);
            remaining -= part.length();
            result.append(applyAttributes(part, attributes));
        }
    }

    private static void discard(OpIterator source, int remaining) {
        while (remaining > 0) {
            Op part = nextDocumentPart(source, remaining);
            remaining -= part.length();
        }
    }

    private static Op nextDocumentPart(OpIterator source, int requestedLength) {
        if (!source.hasNext()) {
            throw new IllegalArgumentException("修改操作超出了文档长度");
        }
        Op part = source.next(requestedLength);
        if (!part.isInsert()) {
            throw new IllegalArgumentException("文档 Delta 只能包含 insert 操作");
        }
        return part;
    }

    private static Op applyAttributes(Op source, Map<String, Object> changeAttributes) {
        if (changeAttributes == null || changeAttributes.isEmpty()) {
            return source;
        }
        Map<String, Object> composed = AttributeMap.compose(
                source.getAttributes(), changeAttributes, false);
        return source.isTextInsert()
                ? Op.insert(source.text(), composed)
                : Op.insertEmbed(source.getInsert(), composed);
    }

    private static void validateDocument(Delta document) {
        for (Op operation : document.getOps()) {
            if (!operation.isInsert()) {
                throw new IllegalArgumentException("文档 Delta 只能包含 insert 操作");
            }
        }
    }

    /** Buffer a complete text run once instead of copying the accumulated
     * document for every small retain/insert in a fragmented change. */
    private static final class DocumentBuilder {
        private final Delta result = new Delta();
        private StringBuilder text;
        private Map<String, Object> attributes;

        private void append(Op operation) {
            if (!operation.isTextInsert()) {
                flush();
                result.push(operation);
                return;
            }
            Map<String, Object> nextAttributes = operation.getAttributes();
            if (text != null && !Objects.equals(attributes, nextAttributes)) flush();
            if (text == null) {
                text = new StringBuilder();
                attributes = nextAttributes;
            }
            text.append(operation.text());
        }

        private void flush() {
            if (text == null) return;
            result.insert(text.toString(), attributes);
            text = null;
            attributes = null;
        }

        private Delta finish() {
            flush();
            return result;
        }
    }
}
