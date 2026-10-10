package com.school.collab.document;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.common.BizException;
import com.school.collab.common.ErrorCode;
import com.school.collab.common.UserContext;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.mock.web.MockMultipartFile;

import java.sql.ResultSet;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class DocumentCreationRequestsTest {
    private static final String KEY="12345678-1234-4123-8123-123456789abc";
    private final JdbcTemplate jdbc=mock(JdbcTemplate.class);
    private final ObjectMapper mapper=new ObjectMapper();
    private final DocumentCreationRequests service=new DocumentCreationRequests(jdbc,mapper);
    private final Map<String,Saved> receipts=new HashMap<>();
    private record Saved(String kind,String hash,String response,long id) { }
    private final DocumentService.CopyView result=new DocumentService.CopyView(41,"中文😀副本",7);

    @BeforeEach void setup() throws Exception {
        UserContext.set(7L,"owner");
        when(jdbc.update(anyString(),any(),any(),any(),any())).thenAnswer(i->{
            String sql=i.getArgument(0);
            if(sql.startsWith("INSERT")) {
                String k=i.getArgument(1)+":"+i.getArgument(2);
                receipts.putIfAbsent(k,new Saved(i.getArgument(3),i.getArgument(4),"",0));
            } else {
                String k=i.getArgument(3)+":"+i.getArgument(4);Saved old=receipts.get(k);
                receipts.put(k,new Saved(old.kind(),old.hash(),i.getArgument(2),i.getArgument(1)));
            }
            return 1;
        });
        doAnswer(i->{
            Saved saved=receipts.get(i.getArgument(2)+":"+i.getArgument(3));
            if(saved==null)return List.of();
            ResultSet rs=mock(ResultSet.class);
            when(rs.getString(1)).thenReturn(saved.kind());when(rs.getString(2)).thenReturn(saved.hash());
            when(rs.getString(3)).thenReturn(saved.response());when(rs.getLong(4)).thenReturn(saved.id());
            return List.of(((RowMapper<?>)i.getArgument(1)).mapRow(rs,0));
        }).when(jdbc).query(anyString(),any(RowMapper.class),any(),any());
    }
    @AfterEach void clear() {UserContext.clear();}
    private DocumentService.CopyView create(String key,String kind,Object input,AtomicInteger calls) {
        return service.execute(key,kind,input,DocumentService.CopyView.class,()->{calls.incrementAndGet();return result;});
    }

    @Test void confirmedRetryAcrossServiceInstancesReturnsOriginalSnapshotWithoutCallingSourceAgain() {
        var calls=new AtomicInteger();var input=new DocumentController.CopyRequest("资料");
        assertEquals(result,create(KEY,"copy:12",input,calls));
        var second=new DocumentCreationRequests(jdbc,new ObjectMapper());
        assertEquals(result,second.execute(KEY.toUpperCase(),"copy:12",input,DocumentService.CopyView.class,
                ()->{throw new AssertionError("不能再次检查来源或创建正文");}));
        assertEquals(1,calls.get());assertEquals(1,receipts.size());
    }
    @Test void changedPayloadAndChangedResourceCannotReuseTheSameRequest() {
        var calls=new AtomicInteger();create(KEY,"copy:12",new DocumentController.CopyRequest("资料"),calls);
        for(String kind:List.of("copy:12","copy:13")) {
            var failure=assertThrows(BizException.class,()->create(KEY,kind,new DocumentController.CopyRequest("不同资料"),calls));
            assertEquals(ErrorCode.PARAM_ERROR,failure.getErrorCode());
        }
        assertEquals(1,calls.get());assertEquals(41,receipts.get("7:"+KEY).id());
    }
    @Test void identifiersAreScopedToTrustedCurrentUser() {
        var calls=new AtomicInteger();create(KEY,"copy:12",Map.of("title","资料"),calls);
        UserContext.set(8L,"peer");create(KEY,"copy:12",Map.of("title","资料"),calls);
        assertEquals(2,calls.get());assertEquals(2,receipts.size());
    }
    @Test void missingKeyPreservesLegacyIndependentCreation() {
        var calls=new AtomicInteger();create(null,"copy:12",Map.of(),calls);create(null,"copy:12",Map.of(),calls);
        assertEquals(2,calls.get());verifyNoInteractions(jdbc);
    }
    @Test void anonymousAndMalformedKeysNeverClaimOrCreate() {
        var calls=new AtomicInteger();UserContext.clear();
        assertEquals(ErrorCode.UNAUTHORIZED,assertThrows(BizException.class,()->create(KEY,"document",Map.of(),calls)).getErrorCode());
        UserContext.set(7L,"owner");
        for(String invalid:List.of(""," ","not-uuid","1-1-1-1-1",KEY+" "))
            assertEquals(ErrorCode.PARAM_ERROR,assertThrows(BizException.class,()->create(invalid,"document",Map.of(),calls)).getErrorCode());
        assertEquals(0,calls.get());verifyNoInteractions(jdbc);
    }
    @Test void failedCreationNeverPublishesSuccessfulReceipt() {
        assertThrows(BizException.class,()->service.execute(KEY,"copy:12",Map.of(),DocumentService.CopyView.class,
                ()->{throw new BizException(ErrorCode.FORBIDDEN);}));
        verify(jdbc,never()).update(startsWith("UPDATE"),any(),any(),any(),any());
    }
    @Test void receiptPersistenceFailureIsPropagatedToTheTransaction() {
        doThrow(new org.springframework.dao.DataAccessResourceFailureException("write failed"))
                .when(jdbc).update(startsWith("UPDATE"),any(),any(),any(),any());
        assertThrows(org.springframework.dao.DataAccessException.class,()->create(KEY,"document",Map.of(),new AtomicInteger()));
    }
    @Test void corruptOrWrongDocumentReceiptsDoNotCreateReplacementDocuments() {
        var input=Map.of("title","资料");String hash=service.fingerprint("copy:12",input);
        for(String response:List.of("bad-json","{\"id\":99,\"title\":\"资料\",\"sourceRevision\":7}")) {
            receipts.put("7:"+KEY,new Saved("copy:12",hash,response,41));
            assertThrows(IllegalStateException.class,()->service.execute(KEY,"copy:12",input,DocumentService.CopyView.class,
                    ()->{throw new AssertionError("不能创建替代文档");}));
        }
    }
    @Test void importFingerprintIncludesActualFileBytesFilenameAndTitle() {
        var a=service.importInput(new MockMultipartFile("file","资料.txt","text/plain","中文😀".getBytes(java.nio.charset.StandardCharsets.UTF_8)),"标题");
        var b=service.importInput(new MockMultipartFile("file","资料.txt","application/octet-stream","中文😀".getBytes(java.nio.charset.StandardCharsets.UTF_8)),"标题");
        assertEquals(service.fingerprint("import",a),service.fingerprint("import",b));
        for(var file:List.of(new MockMultipartFile("file","其他.txt","text/plain","中文😀".getBytes(java.nio.charset.StandardCharsets.UTF_8)),
                new MockMultipartFile("file","资料.txt","text/plain","不同".getBytes(java.nio.charset.StandardCharsets.UTF_8))))
            assertNotEquals(service.fingerprint("import",a),service.fingerprint("import",service.importInput(file,"标题")));
    }
}
