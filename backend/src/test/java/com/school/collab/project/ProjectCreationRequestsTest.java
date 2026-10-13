package com.school.collab.project;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.common.BizException;
import com.school.collab.common.ErrorCode;
import com.school.collab.common.UserContext;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.annotation.AnnotationTransactionAttributeSource;

import java.sql.ResultSet;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class ProjectCreationRequestsTest {
    private static final String KEY="12345678-1234-4123-8123-123456789abc";
    private record Saved(String hash,long project,long group) { }
    private final Map<String,Saved> rows=new HashMap<>();
    private final ProjectService projects=mock(ProjectService.class);
    private final ObjectMapper mapper=new ObjectMapper();
    private final JdbcTemplate jdbc=mock(JdbcTemplate.class,call->{
        String sql=call.getArgument(0);
        assertFalse(sql.contains("doc_creation_receipt"));assertFalse(sql.contains("document"));
        if(sql.startsWith("INSERT")) {
            assertTrue(sql.contains("ON DUPLICATE KEY UPDATE project_id=IF(project_id=0,-1,project_id)"));
            String key=call.getArgument(1)+":"+call.getArgument(2);
            Saved old=rows.get(key);
            rows.put(key,old==null?new Saved(call.getArgument(3),0,call.getArgument(4))
                :new Saved(old.hash(),old.project()==0?-1:old.project(),old.group()));
            return 1;
        }
        if(sql.startsWith("UPDATE")) {
            assertTrue(sql.contains("AND project_id=0"));
            String key=call.getArgument(2)+":"+call.getArgument(3);Saved old=rows.get(key);
            if(old==null||old.project()!=0)return 0;
            rows.put(key,new Saved(old.hash(),call.getArgument(1),old.group()));return 1;
        }
        assertEquals("SELECT request_hash,project_id,group_id FROM project_creation_receipt WHERE user_id=? AND request_id=?",sql);
        Saved old=rows.get(call.getArgument(2)+":"+call.getArgument(3));
        if(old==null)return List.of();
        ResultSet row=mock(ResultSet.class);
        when(row.getString(1)).thenReturn(old.hash());when(row.getLong(2)).thenReturn(old.project());when(row.getLong(3)).thenReturn(old.group());
        return List.of(((RowMapper<?>)call.getArgument(1)).mapRow(row,0));
    });
    private final ProjectCreationRequests service=new ProjectCreationRequests(jdbc,mapper,projects);
    @BeforeEach void setup() {
        UserContext.set(7L,"owner");
        when(projects.create("项目","简介",3)).thenReturn(new ProjectService.IdView(41,3));
        when(projects.replayCreation(41,3)).thenReturn(new ProjectService.IdView(41,3));
    }
    @AfterEach void clear() {UserContext.clear();}
    private ProjectService.IdView create(String key) {return service.execute(key,"项目","简介",3);}

    @Test void canonicalRetryAcrossInstancesReturnsOriginalIdAndChecksCurrentAccess() {
        assertEquals(new ProjectService.IdView(41,3),create(KEY));
        var other=new ProjectCreationRequests(jdbc,new ObjectMapper(),projects);
        assertEquals(new ProjectService.IdView(41,3),other.execute(KEY.toUpperCase(),"项目","简介",3));
        assertEquals(1,rows.size());verify(projects).create("项目","简介",3);verify(projects).replayCreation(41,3);verifyNoMoreInteractions(projects);
    }
    @Test void alteredNameDescriptionAndGroupCannotReuseOriginalKey() {
        create(KEY);
        for(Runnable changed:List.<Runnable>of(()->service.execute(KEY,"另一项目","简介",3),
                ()->service.execute(KEY,"项目","另一简介",3),()->service.execute(KEY,"项目","简介",0)))
            assertEquals(ErrorCode.PARAM_ERROR,assertThrows(BizException.class,changed::run).getErrorCode());
        assertEquals(41,rows.get("7:"+KEY).project());verify(projects).create("项目","简介",3);verifyNoMoreInteractions(projects);
    }
    @Test void trustedAccountsHaveIndependentKeys() {
        create(KEY);UserContext.set(8L,"peer");create(KEY);
        assertEquals(2,rows.size());verify(projects,times(2)).create("项目","简介",3);verify(projects,never()).replayCreation(anyLong(),anyLong());
    }
    @Test void missingKeyPreservesLegacyIndependentCreationWithoutReceipts() {
        create(null);create(null);verify(projects,times(2)).create("项目","简介",3);verifyNoInteractions(jdbc);
    }
    @Test void anonymousAndMalformedKeysCannotClaimOrCreate() {
        UserContext.clear();assertEquals(ErrorCode.UNAUTHORIZED,assertThrows(BizException.class,()->create(KEY)).getErrorCode());
        UserContext.set(7L,"owner");
        for(String key:List.of(""," ","bad","1-1-1-1-1",KEY+" "))
            assertEquals(ErrorCode.PARAM_ERROR,assertThrows(BizException.class,()->create(key)).getErrorCode());
        verifyNoInteractions(jdbc);verify(projects,never()).create(any(),any(),anyLong());
    }
    @Test void originalRawPayloadFingerprintIsStableAndNotBasedOnCurrentProjectFields() {
        String hash=service.fingerprint("项目","简介",3);
        assertEquals(64,hash.length());assertEquals(hash,new ProjectCreationRequests(jdbc,new ObjectMapper(),projects).fingerprint("项目","简介",3));
        assertNotEquals(hash,service.fingerprint(" 项目 ","简介",3));
        assertNotEquals(service.fingerprint("项目",null,0),service.fingerprint("项目","",0));
        verifyNoInteractions(jdbc);
    }
    @Test void currentPermissionDenialDoesNotCreateOrReplaceACommittedReceipt() {
        create(KEY);
        for(ErrorCode denied:new ErrorCode[]{ErrorCode.FORBIDDEN,ErrorCode.NOT_FOUND}) {
            doThrow(new BizException(denied)).when(projects).replayCreation(41,3);
            assertEquals(denied,assertThrows(BizException.class,()->create(KEY)).getErrorCode());
        }
        assertEquals(41,rows.get("7:"+KEY).project());verify(projects).create("项目","简介",3);verify(projects,times(2)).replayCreation(41,3);
    }
    @Test void zeroNegativeOrWrongGroupReceiptsAreNeverTreatedAsFreshCreation() {
        String hash=service.fingerprint("项目","简介",3);
        for(Saved bad:List.of(new Saved(hash,0,3),new Saved(hash,-1,3),new Saved(hash,41,-1),new Saved(hash,41,4))) {
            rows.put("7:"+KEY,bad);assertThrows(IllegalStateException.class,()->create(KEY));
        }
        verify(projects,never()).create(any(),any(),anyLong());verify(projects,never()).replayCreation(anyLong(),anyLong());
    }
    @Test void failedCreationDoesNotPublishASuccessfulReceipt() {
        doThrow(new BizException(ErrorCode.FORBIDDEN)).when(projects).create("项目","简介",3);
        assertThrows(BizException.class,()->create(KEY));
        verify(jdbc,never()).update(startsWith("UPDATE"),any(),any(),any());
    }
    @Test void receiptSaveFailureAndMissingUpdatedRowPropagateForTransactionRollback() {
        doThrow(new DataAccessResourceFailureException("save failed")).when(jdbc).update(startsWith("UPDATE"),any(),any(),any());
        assertThrows(DataAccessResourceFailureException.class,()->create(KEY));
        rows.clear();doReturn(0).when(jdbc).update(startsWith("UPDATE"),any(),any(),any());
        assertThrows(IllegalStateException.class,()->create(KEY));
    }
    @Test void missingReceiptReadDoesNotCreateAReplacement() {
        doReturn(List.of()).when(jdbc).query(anyString(),any(RowMapper.class),any(),any());
        assertThrows(IllegalStateException.class,()->create(KEY));verify(projects,never()).create(any(),any(),anyLong());
    }
    @Test void invalidFirstResultIsNotPublished() {
        for(ProjectService.IdView bad:List.of(new ProjectService.IdView(0,3),new ProjectService.IdView(41,4))) {
            rows.clear();doReturn(bad).when(projects).create("项目","简介",3);
            assertThrows(IllegalStateException.class,()->create(KEY));
        }
        verify(jdbc,never()).update(startsWith("UPDATE"),any(),any(),any());
    }
    @Test void receiptAndCreationUseOneReadCommittedRequiredTransactionWithRollbackOnFailures() throws Exception {
        var source=new AnnotationTransactionAttributeSource();
        var tx=source.getTransactionAttribute(ProjectCreationRequests.class.getMethod("execute",String.class,String.class,String.class,long.class),ProjectCreationRequests.class);
        assertNotNull(tx);assertFalse(tx.isReadOnly());assertEquals(TransactionDefinition.ISOLATION_READ_COMMITTED,tx.getIsolationLevel());
        assertEquals(TransactionDefinition.PROPAGATION_REQUIRED,tx.getPropagationBehavior());
        assertTrue(tx.rollbackOn(new BizException(ErrorCode.FORBIDDEN)));assertTrue(tx.rollbackOn(new DataAccessResourceFailureException("save")));
        assertTrue(tx.rollbackOn(new IllegalStateException("bad receipt")));
        var createTx=source.getTransactionAttribute(ProjectService.class.getMethod("create",String.class,String.class,long.class),ProjectService.class);
        assertNotNull(createTx);assertEquals(TransactionDefinition.PROPAGATION_REQUIRED,createTx.getPropagationBehavior());
    }
}
