package com.school.collab.group;

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
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class GroupCreationRequestsTest {
    private static final String KEY="12345678-1234-4123-8123-123456789abc";
    private record Saved(String hash,long group) { }
    private final Map<String,Saved> rows=new HashMap<>();
    private final GroupService groups=mock(GroupService.class);
    private final ObjectMapper mapper=new ObjectMapper();
    private final JdbcTemplate jdbc=mock(JdbcTemplate.class,call->{
        String sql=call.getArgument(0);
        assertFalse(sql.contains("doc_creation_receipt"));assertFalse(sql.contains("project_creation_receipt"));assertFalse(sql.contains("document"));
        if(sql.startsWith("INSERT")) {
            assertTrue(sql.contains("ON DUPLICATE KEY UPDATE group_id=IF(group_id=0,-1,group_id)"));
            String key=call.getArgument(1)+":"+call.getArgument(2); Saved old=rows.get(key);
            rows.put(key,old==null?new Saved(call.getArgument(3),0):new Saved(old.hash(),old.group()==0?-1:old.group()));
            return 1;
        }
        if(sql.startsWith("UPDATE")) {
            assertTrue(sql.contains("AND group_id=0"));
            String key=call.getArgument(2)+":"+call.getArgument(3);Saved old=rows.get(key);
            if(old==null||old.group()!=0)return 0;
            rows.put(key,new Saved(old.hash(),call.getArgument(1)));return 1;
        }
        assertEquals("SELECT request_hash,group_id FROM group_creation_receipt WHERE user_id=? AND request_id=?",sql);
        Saved old=rows.get(call.getArgument(2)+":"+call.getArgument(3));
        if(old==null)return List.of();
        ResultSet row=mock(ResultSet.class);
        when(row.getString(1)).thenReturn(old.hash());when(row.getLong(2)).thenReturn(old.group());
        return List.of(((RowMapper<?>)call.getArgument(1)).mapRow(row,0));
    });
    private final GroupCreationRequests service=new GroupCreationRequests(jdbc,mapper,groups);
    @BeforeEach void setup() {
        UserContext.set(7L,"owner");
        when(groups.create("小组","简介")).thenReturn(new GroupService.IdView(41));
        when(groups.replayCreation(41)).thenReturn(new GroupService.CreationView(41,false,"小组"));
    }
    @AfterEach void clear() {UserContext.clear();}
    private GroupService.CreationView create(String key) {return service.execute(key,"小组","简介");}

    @Test void canonicalRetryAcrossInstancesReturnsOriginalIdAndChecksCurrentOwner() {
        assertEquals(new GroupService.CreationView(41,false,"小组"),create(KEY));
        var other=new GroupCreationRequests(jdbc,new ObjectMapper(),groups);
        assertEquals(new GroupService.CreationView(41,false,"小组"),other.execute(KEY.toUpperCase(),"小组","简介"));
        assertEquals(1,rows.size());verify(groups).create("小组","简介");verify(groups,times(2)).replayCreation(41);verifyNoMoreInteractions(groups);
    }
    @Test void renamedAndArchivedGroupStillReturnsOriginalIdAndCurrentArchiveStateWithoutRecreating() {
        create(KEY);
        String originalHash=rows.get("7:"+KEY).hash();
        doReturn(new GroupService.CreationView(41,true,"已改名且归档")).when(groups).replayCreation(41);
        assertEquals(new GroupService.CreationView(41,true,"已改名且归档"),create(KEY));
        doReturn(new GroupService.CreationView(41,false,"再次改名")).when(groups).replayCreation(41);
        assertEquals(new GroupService.CreationView(41,false,"再次改名"),create(KEY));
        assertEquals(originalHash,rows.get("7:"+KEY).hash());
        verify(groups).create("小组","简介");verify(groups,times(3)).replayCreation(41);verifyNoMoreInteractions(groups);
    }
    @Test void alteredRawNameDescriptionOrNullCannotReuseTheOriginalKey() {
        create(KEY);
        for(Runnable changed:List.<Runnable>of(()->service.execute(KEY,"另一小组","简介"),
                ()->service.execute(KEY,"小组","另一简介"),()->service.execute(KEY," 小组 ","简介"),
                ()->service.execute(KEY,"小组",null)))
            assertEquals(ErrorCode.PARAM_ERROR,assertThrows(BizException.class,changed::run).getErrorCode());
        assertEquals(41,rows.get("7:"+KEY).group());verify(groups).create("小组","简介");verify(groups).replayCreation(41);verifyNoMoreInteractions(groups);
    }
    @Test void trustedAccountsHaveIndependentKeys() {
        create(KEY);UserContext.set(8L,"peer");create(KEY);
        assertEquals(2,rows.size());verify(groups,times(2)).create("小组","简介");verify(groups,times(2)).replayCreation(41);
    }
    @Test void absentKeyPreservesLegacyIndependentCreationAndCompatibleIdWithoutReceipts() {
        assertEquals(new GroupService.CreationView(41,false,"小组"),create(null));create(null);
        verify(groups,times(2)).create("小组","简介");verify(groups,times(2)).replayCreation(41);verifyNoInteractions(jdbc);
    }
    @Test void anonymousAndMalformedKeysCannotClaimOrCreate() {
        UserContext.clear();assertEquals(ErrorCode.UNAUTHORIZED,assertThrows(BizException.class,()->create(KEY)).getErrorCode());
        UserContext.set(7L,"owner");
        for(String key:List.of(""," ","bad","1-1-1-1-1",KEY+" "))
            assertEquals(ErrorCode.PARAM_ERROR,assertThrows(BizException.class,()->create(key)).getErrorCode());
        verifyNoInteractions(jdbc);verify(groups,never()).create(any(),any());
    }
    @Test void rawPayloadFingerprintIsStableAndDistinctForWhitespaceEmptyAndNull() {
        String hash=service.fingerprint("小组","简介");
        assertEquals(64,hash.length());assertEquals(hash,new GroupCreationRequests(jdbc,new ObjectMapper(),groups).fingerprint("小组","简介"));
        assertNotEquals(hash,service.fingerprint(" 小组 ","简介"));
        assertNotEquals(service.fingerprint("小组",null),service.fingerprint("小组",""));
        assertNotEquals(service.fingerprint("小组",""),service.fingerprint("小组"," "));
        verifyNoInteractions(jdbc);
    }
    @Test void firstCreationReturnsPersistedNormalizedNameWhileKeepingRawReceiptFingerprint() {
        var repository=mock(GroupRepository.class);
        when(repository.create("规范名称","简介",7)).thenReturn(51L);
        when(repository.role(51,7)).thenReturn("owner");
        when(repository.find(51,false)).thenReturn(Optional.of(new GroupRepository.Group(51,"规范名称","简介",7,false)));
        var actual=new GroupCreationRequests(jdbc,mapper,new GroupService(repository));
        String rawName=" 规范名称 ",rawDescription=" 简介 ";
        assertEquals(new GroupService.CreationView(51,false,"规范名称"),actual.execute(KEY,rawName,rawDescription));
        String rawHash=actual.fingerprint(rawName,rawDescription);
        assertEquals(rawHash,rows.get("7:"+KEY).hash());
        assertNotEquals(actual.fingerprint("规范名称","简介"),rawHash);
        when(repository.find(51,false)).thenReturn(Optional.of(new GroupRepository.Group(51,"改名后的真实名称","新简介",7,true)));
        assertEquals(new GroupService.CreationView(51,true,"改名后的真实名称"),actual.execute(KEY,rawName,rawDescription));
        assertEquals(rawHash,rows.get("7:"+KEY).hash());
        verify(repository).create("规范名称","简介",7);verify(repository).add(51,7,"owner");
        verify(repository,times(2)).find(51,false);verify(repository,times(2)).role(51,7);verifyNoMoreInteractions(repository);
    }
    @Test void confirmationWithMissingOrBlankCurrentNameIsNotPublished() {
        rows.put("7:"+KEY,new Saved(service.fingerprint("小组","简介"),41));
        for(String name:new String[]{null,""," "}) {
            doReturn(new GroupService.CreationView(41,false,name)).when(groups).replayCreation(41);
            assertThrows(IllegalStateException.class,()->create(KEY));
        }
        verify(groups,never()).create(any(),any());
        assertEquals(41,rows.get("7:"+KEY).group());
    }
    @Test void currentOwnerDenialOrMissingOriginalDoesNotReplaceCommittedReceipt() {
        create(KEY);
        for(ErrorCode denied:new ErrorCode[]{ErrorCode.FORBIDDEN,ErrorCode.NOT_FOUND}) {
            doThrow(new BizException(denied)).when(groups).replayCreation(41);
            assertEquals(denied,assertThrows(BizException.class,()->create(KEY)).getErrorCode());
        }
        assertEquals(41,rows.get("7:"+KEY).group());verify(groups).create("小组","简介");verify(groups,times(3)).replayCreation(41);
    }
    @Test void committedZeroOrNegativeReceiptsAreNeverTreatedAsFreshCreation() {
        String hash=service.fingerprint("小组","简介");
        for(long id:new long[]{0,-1,-52}) {
            rows.put("7:"+KEY,new Saved(hash,id));assertThrows(IllegalStateException.class,()->create(KEY));
        }
        verify(groups,never()).create(any(),any());verify(groups,never()).replayCreation(anyLong());
    }
    @Test void failedCreationDoesNotPublishSuccessfulReceipt() {
        doThrow(new BizException(ErrorCode.PARAM_ERROR)).when(groups).create("小组","简介");
        assertThrows(BizException.class,()->create(KEY));
        verify(jdbc,never()).update(startsWith("UPDATE"),any(),any(),any());
    }
    @Test void saveFailureAndMissingUpdatedRowPropagateForTransactionRollback() {
        doThrow(new DataAccessResourceFailureException("save failed")).when(jdbc).update(startsWith("UPDATE"),any(),any(),any());
        assertThrows(DataAccessResourceFailureException.class,()->create(KEY));
        rows.clear();doReturn(0).when(jdbc).update(startsWith("UPDATE"),any(),any(),any());
        assertThrows(IllegalStateException.class,()->create(KEY));
    }
    @Test void missingReceiptReadDoesNotCreateReplacement() {
        doReturn(List.of()).when(jdbc).query(anyString(),any(RowMapper.class),any(),any());
        assertThrows(IllegalStateException.class,()->create(KEY));verify(groups,never()).create(any(),any());
    }
    @Test void invalidFirstResultOrReplayIdIsNotPublished() {
        doReturn(new GroupService.IdView(0)).when(groups).create("小组","简介");
        assertThrows(IllegalStateException.class,()->create(KEY));
        verify(jdbc,never()).update(startsWith("UPDATE"),any(),any(),any());
        rows.put("7:"+KEY,new Saved(service.fingerprint("小组","简介"),41));
        doReturn(new GroupService.CreationView(42,false,"其他组")).when(groups).replayCreation(41);
        assertThrows(IllegalStateException.class,()->create(KEY));
        assertEquals(41,rows.get("7:"+KEY).group());
    }
    @Test void receiptGroupAndOwnerCreationShareOneRequiredReadCommittedRollbackTransaction() throws Exception {
        var source=new AnnotationTransactionAttributeSource();
        var tx=source.getTransactionAttribute(GroupCreationRequests.class.getMethod("execute",String.class,String.class,String.class),GroupCreationRequests.class);
        assertNotNull(tx);assertFalse(tx.isReadOnly());assertEquals(TransactionDefinition.ISOLATION_READ_COMMITTED,tx.getIsolationLevel());
        assertEquals(TransactionDefinition.PROPAGATION_REQUIRED,tx.getPropagationBehavior());
        assertTrue(tx.rollbackOn(new BizException(ErrorCode.PARAM_ERROR)));assertTrue(tx.rollbackOn(new DataAccessResourceFailureException("save")));
        assertTrue(tx.rollbackOn(new IllegalStateException("bad receipt")));
        var createTx=source.getTransactionAttribute(GroupService.class.getMethod("create",String.class,String.class),GroupService.class);
        assertNotNull(createTx);assertEquals(TransactionDefinition.PROPAGATION_REQUIRED,createTx.getPropagationBehavior());
    }
}
