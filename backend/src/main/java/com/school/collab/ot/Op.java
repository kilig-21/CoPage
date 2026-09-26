package com.school.collab.ot;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.annotation.JsonAutoDetect;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.TextNode;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;


@JsonInclude(value = JsonInclude.Include.NON_NULL, content = JsonInclude.Include.ALWAYS)
@JsonAutoDetect(
        fieldVisibility = JsonAutoDetect.Visibility.ANY,
        getterVisibility = JsonAutoDetect.Visibility.NONE,
        isGetterVisibility = JsonAutoDetect.Visibility.NONE
)
public final class Op {

    @JsonProperty("insert")
    private JsonNode insert;

    @JsonProperty("retain")
    private Integer retain;

    @JsonProperty("delete")
    private Integer delete;

    @JsonProperty("attributes")
    private Map<String, Object> attributes;

    /**
    * Json反序列化需要无参构造
    * */

    public Op(){}

    //有参构造方法
    private Op(JsonNode insert, Integer retain, Integer delete, Map<String, Object> attributes) {
        this.insert = insert;
        this.retain = retain;
        this.delete = delete;
        this.attributes = copyAttributes(attributes);
    }

    /**
    * 在当前位置插入文字
    * */
    public static Op insert(String text,Map<String,Object> attributes){
        if(text == null || text.isEmpty()){throw new IllegalArgumentException("Text cannot be null or empty");}
        return new Op(TextNode.valueOf(text), null, null, attributes);
    }
    public static Op insert (String text) {
        return insert(text,null);
    }


    /**
    * 插入图片等非文本内容
    * */
    public static Op insertEmbed(JsonNode embed){
        return insertEmbed(embed, null);
    }
    public static Op insertEmbed(JsonNode embed, Map<String, Object> attributes){
        if(embed == null || !embed.isObject() || embed.isEmpty()){
            throw new IllegalArgumentException("Embed cannot be null or empty");
        }
        return new Op(embed.deepCopy(), null, null, attributes);
    }

    /**
    * 跳过前 3 个字符，光标往后走
    * */
    public static Op retain(int length, Map<String, Object> attributes) {
        if (length <= 0) {
            throw new IllegalArgumentException("retain 长度必须大于 0");
        }
        return new Op(null, length, null, attributes);
    }
    public static Op retain(int length) {
        return retain(length, null);
    }

    /**
    * 删除当前位置后 2 个字符
    * */
    public static Op delete(int length) {
        if (length <= 0) {
            throw new IllegalArgumentException("delete 长度必须大于 0");
        }
        return new Op(null, null, length, null);
    }

    /**
     * 判断这条操作到底是插入、保留还是删除；并确保三者只能有一个
     * 和算这条操作影响多少字符
     * */
    public Kind kind(){
        int count = (insert !=null? 1:0)
                + (retain!=null? 1:0)
                + (delete!=null? 1:0);

        if (count != 1) {
            throw new IllegalStateException("一条 Op 必须且只能包含 insert、retain、delete 中的一种");
        }
        if ((retain != null && retain <= 0) || (delete != null && delete <= 0)) {
            throw new IllegalStateException("retain/delete 长度必须大于 0");
        }
        if (insert != null && !((insert.isTextual() && !insert.textValue().isEmpty())
                || (insert.isObject() && !insert.isEmpty()))) {
            throw new IllegalStateException("insert 必须是非空文本或嵌入对象");
        }

        if (insert != null) return Kind.INSERT;
        if (retain != null) return Kind.RETAIN;
        return Kind.DELETE;
    }
    public int length() {
        return switch (kind()) {
            case RETAIN -> retain;
            case DELETE -> delete;
            case INSERT -> insert.isTextual() ? insert.textValue().length() : 1;
        };
    }

    /**
    * 快速判断修改类型
    * */
    public boolean isInsert() {
        return kind() == Kind.INSERT;
    }
    public boolean isRetain() {
        return kind() == Kind.RETAIN;
    }
    public boolean isDelete() {
        return kind() == Kind.DELETE;
    }

    /**
    * 判断插入的是不是文字，并安全取出文本。图片插入就不能当字符串取。
    * */
    public boolean isTextInsert() {
        return isInsert() && insert.isTextual();
    }
    public String text() {
        if (!isTextInsert()) {
            throw new IllegalStateException("当前操作不是文本插入");
        }
        return insert.textValue();
    }

    /**
    * 复制一份操作，避免后续算法修改原对象导致意外影响。
    * */
    public Op copy() {
        return new Op(
                insert == null ? null : insert.deepCopy(),
                retain,
                delete,
                attributes
        );
    }


    /**
    * 让 Jackson 能把 Java 对象序列化成 WebSocket 要发的 JSON。
    * */
    public JsonNode getInsert() {return insert;}
    public Integer getRetain() {return retain;}
    public Integer getDelete() {return delete;}
    public Map<String, Object> getAttributes() {return copyAttributes(attributes);}

    /**
    * 复制加粗、颜色等属性，避免外部拿到内部 Map 后随手改掉。
    * */
    private static Map<String, Object> copyAttributes(Map<String, Object> source) {
        return source == null || source.isEmpty() ? null : new LinkedHashMap<>(source);
    }


    @Override
    public boolean equals(Object other) {
        if (this == other) return true;
        if (!(other instanceof Op op)) return false;
        return Objects.equals(insert, op.insert)
                && Objects.equals(retain, op.retain)
                && Objects.equals(delete, op.delete)
                && Objects.equals(attributes, op.attributes);
    }

    @Override
    public int hashCode() {
        return Objects.hash(insert, retain, delete, attributes);
    }


    public enum Kind {
        INSERT, RETAIN, DELETE
    }
}
