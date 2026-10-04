package com.school.collab.document;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;

class DocumentFormatsTest {
    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void 正常文字图片格式删除与格式移除可提交() throws Exception {
        var operation = mapper.readTree("""
                {"ops":[{"insert":"中文😀","attributes":{"bold":true,"color":"rgb(255, 0, 0)"}},
                {"insert":{"image":"http://localhost:9000/collab/test.png"},
                 "attributes":{"width":"64","height":"100%","alt":"图片说明"}},
                {"retain":3,"attributes":{"bold":null,"link":null,"header":2}}, {"delete":1}]}
                """);
        assertDoesNotThrow(() -> DocumentFormats.validateEditorOperation(operation));
    }

    @Test
    void 未支持的嵌入图片地址和格式不能落库() throws Exception {
        for (String op : new String[]{
                "{\"insert\":{\"unsupported\":\"qa\"}}", "{\"insert\":{\"video\":\"https://example.com/\"}}",
                "{\"insert\":{\"formula\":\"x\"}}", "{\"insert\":{\"image\":\"javascript:alert(1)\"}}",
                "{\"insert\":{\"image\":\"https://user:pass@example.com/a.png\"}}",
                "{\"insert\":{\"image\":\"https://example.com/a.png\",\"other\":1}}",
                "{\"insert\":\"x\",\"attributes\":{\"width\":100}}",
                "{\"insert\":{\"image\":\"https://example.com/a.png\"},\"attributes\":{\"width\":\"10001\"}}",
                "{\"insert\":{\"image\":\"https://example.com/a.png\"},\"attributes\":{\"height\":\"101%\"}}",
                "{\"insert\":\"x\",\"attributes\":{\"link\":\"javascript:alert(1)\"}}",
                "{\"retain\":1,\"attributes\":{\"unsupported\":null}}",
                "{\"insert\":\"x\",\"attributes\":{\"bold\":null}}"
        }) {
            var operation = mapper.readTree("{\"ops\":[" + op + "]}");
            assertThrows(IllegalArgumentException.class, () -> DocumentFormats.validateEditorOperation(operation), op);
        }
    }

    @Test
    void 编辑Delta长度字段不能被宽松转换且未知字段不能忽略() throws Exception {
        for (String json : new String[]{
                "{\"ops\":[]}", "{\"ops\":[{\"retain\":1.5}]}", "{\"ops\":[{\"delete\":\"1\"}]}",
                "{\"ops\":[{\"delete\":2147483648}]}", "{\"ops\":[{\"retain\":0}]}",
                "{\"ops\":[{\"insert\":\"x\",\"delete\":1}]}", "{\"ops\":[{\"insert\":\"x\",\"unknown\":true}]}",
                "{\"ops\":[{\"insert\":\"x\"}],\"unknown\":true}", "{\"ops\":[{\"delete\":1,\"attributes\":{}}]}",
                "{\"ops\":[{\"insert\":\"\\u0000\"}]}"
        }) {
            var operation = mapper.readTree(json);
            assertThrows(IllegalArgumentException.class, () -> DocumentFormats.validateEditorOperation(operation), json);
        }
    }
}
