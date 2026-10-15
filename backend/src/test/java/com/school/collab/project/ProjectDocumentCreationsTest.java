package com.school.collab.project;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.common.BizException;
import com.school.collab.common.ErrorCode;
import com.school.collab.common.UserContext;
import com.school.collab.document.DocumentCreationRequests;
import com.school.collab.document.DocumentRepository;
import com.school.collab.document.DocumentService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.annotation.AnnotationTransactionAttributeSource;

import java.sql.ResultSet;
import java.time.LocalDateTime;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.Supplier;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class ProjectDocumentCreationsTest {
    private static final String KEY="12345678-1234-4123-8123-123456789abc";
    private final ProjectService projects=mock(ProjectService.class);
    private final DocumentService documents=mock(DocumentService.class);
    private final ObjectMapper mapper=new ObjectMapper();
    private final JdbcTemplate jdbc=mock(JdbcTemplate.class);
    private final Map<String,Saved> receipts=new HashMap<>();
    private record Saved(String kind,String hash,String response,long id) { }
    private final DocumentCreationRequests requests=new DocumentCreationRequests(jdbc,mapper);
    private final ProjectDocumentCreations service=new ProjectDocumentCreations(requests,documents,projects);

    @BeforeEach void setup() throws Exception {
        UserContext.set(7L,"creator");
        when(documents.create(any(),eq(0L),any())).thenReturn(summary(41,"规范标题"));
        when(projects.add(anyLong(),anyLong())).thenReturn(new ProjectService.Change(true));
        when(jdbc.update(anyString(),any(),any(),any(),any())).thenAnswer(call->{
            String sql=call.getArgument(0);
            if(sql.startsWith("INSERT INTO doc_creation_receipt")) {
                String key=call.getArgument(1)+":"+call.getArgument(2);
                receipts.putIfAbsent(key,new Saved(call.getArgument(3),call.getArgument(4),"",0));
            } else {
                assertTrue(sql.startsWith("UPDATE doc_creation_receipt SET doc_id=?,response_json=?"));
                String key=call.getArgument(3)+":"+call.getArgument(4);Saved old=receipts.get(key);
                receipts.put(key,new Saved(old.kind(),old.hash(),call.getArgument(2),call.getArgument(1)));
            }
            return 1;
        });
        doAnswer(call->{
            assertEquals("SELECT kind, request_hash, response_json, doc_id FROM doc_creation_receipt WHERE user_id=? AND request_id=?",call.getArgument(0));
            Saved saved=receipts.get(call.getArgument(2)+":"+call.getArgument(3));
            if(saved==null)return List.of();
            ResultSet row=mock(ResultSet.class);
            when(row.getString(1)).thenReturn(saved.kind());when(row.getString(2)).thenReturn(saved.hash());
            when(row.getString(3)).thenReturn(saved.response());when(row.getLong(4)).thenReturn(saved.id());
            return List.of(((RowMapper<?>)call.getArgument(1)).mapRow(row,0));
        }).when(jdbc).query(anyString(),any(RowMapper.class),any(),any());
    }
    @AfterEach void clear() {UserContext.clear();}
    private static DocumentService.SummaryView summary(long id,String title) {
        return new DocumentService.SummaryView(id,title,7,"creator",0,"2026-10-16 10:00:00",2,true);
    }
    private ProjectDocumentCreations.Created create(String key) {return service.execute(key,10," 原始标题 ",null);}

    @Test void firstBlankCreationLocksAccessBeforeBodyThenExplicitAssociationAndStoresOnlyOriginalSummary() throws Exception {
        var created=create(KEY);
        assertEquals(new ProjectDocumentCreations.Created(41,10,"规范标题"),created);
        var order=inOrder(projects,documents);
        order.verify(projects).lockForDocumentCreation(10);
        order.verify(documents).create(" 原始标题 ",0,null);
        order.verify(projects).add(10,41);
        verifyNoMoreInteractions(projects,documents);
        Saved receipt=receipts.get("7:"+KEY);
        assertEquals("project-document:10",receipt.kind());assertEquals(41,receipt.id());
        assertEquals(mapper.readTree("{\"id\":41,\"projectId\":10,\"title\":\"规范标题\"}"),mapper.readTree(receipt.response()));
        assertEquals(3,mapper.valueToTree(created).size());
        verify(jdbc,never()).execute(anyString());
    }
    @Test void builtInTemplateAndRawNullTitleArePassedUnchangedToExistingDocumentCreation() {
        when(documents.create(null,0,"meeting")).thenReturn(summary(42,"会议纪要"));
        assertEquals(new ProjectDocumentCreations.Created(42,10,"会议纪要"),service.execute(KEY,10,null,"meeting"));
        var order=inOrder(projects,documents);order.verify(projects).lockForDocumentCreation(10);
        order.verify(documents).create(null,0,"meeting");order.verify(projects).add(10,42);
        verifyNoMoreInteractions(projects,documents);
    }
    @Test void replayAcrossInstancesDoesNotRecheckProjectOrDocumentOrRecreateRemovedAssociation() {
        var original=create(KEY);
        doThrow(new AssertionError("项目已归档或成员已退出，不应再次检查原项目")).when(projects).lockForDocumentCreation(anyLong());
        doThrow(new AssertionError("关联已移除，不应补回")).when(projects).add(anyLong(),anyLong());
        doThrow(new AssertionError("原文档已删除，不应创建替代正文")).when(documents).create(any(),anyLong(),any());
        var other=new ProjectDocumentCreations(new DocumentCreationRequests(jdbc,new ObjectMapper()),documents,projects);
        assertEquals(original,other.execute(KEY.toUpperCase(),10," 原始标题 ",null));
        assertEquals(1,receipts.size());verify(projects).lockForDocumentCreation(10);verify(projects).add(10,41);
        verify(documents).create(" 原始标题 ",0,null);verifyNoMoreInteractions(projects,documents);
    }
    @Test void changedRawTitleTemplateOrTargetProjectCannotReuseSameKey() {
        create(KEY);String originalHash=receipts.get("7:"+KEY).hash();
        for(Runnable altered:List.<Runnable>of(()->service.execute(KEY,10,"原始标题",null),
                ()->service.execute(KEY,10," 原始标题 ","meeting"),
                ()->service.execute(KEY,11," 原始标题 ",null),
                ()->service.execute(KEY,10,null,null)))
            assertEquals(ErrorCode.PARAM_ERROR,assertThrows(BizException.class,altered::run).getErrorCode());
        assertEquals(originalHash,receipts.get("7:"+KEY).hash());
        verify(projects).lockForDocumentCreation(10);verify(projects).add(10,41);
        verify(documents).create(" 原始标题 ",0,null);verifyNoMoreInteractions(projects,documents);
    }
    @Test void rawTemplateWhitespaceAlsoConflictsWithOriginalReceiptWithoutRenormalizingInput() {
        service.execute(KEY,10,"标题","meeting");
        assertEquals(ErrorCode.PARAM_ERROR,assertThrows(BizException.class,()->service.execute(KEY,10,"标题"," meeting ")).getErrorCode());
        verify(documents).create("标题",0,"meeting");verify(projects).lockForDocumentCreation(10);
        verify(projects).add(10,41);verifyNoMoreInteractions(projects,documents);
    }
    @Test void trustedAccountsHaveIndependentRequestReceipts() {
        create(KEY);UserContext.set(8L,"another-creator");create(KEY);
        assertEquals(2,receipts.size());assertTrue(receipts.containsKey("7:"+KEY));assertTrue(receipts.containsKey("8:"+KEY));
        verify(projects,times(2)).lockForDocumentCreation(10);verify(documents,times(2)).create(" 原始标题 ",0,null);
        verify(projects,times(2)).add(10,41);
    }
    @Test void missingKeyCreatesIndependentlyAndDoesNotUseAReceipt() {
        when(documents.create(" 原始标题 ",0,null)).thenReturn(summary(41,"第一篇"),summary(42,"第二篇"));
        assertEquals(41,create(null).id());assertEquals(42,create(null).id());
        verify(projects,times(2)).lockForDocumentCreation(10);verify(projects).add(10,41);verify(projects).add(10,42);
        verify(documents,times(2)).create(" 原始标题 ",0,null);verifyNoInteractions(jdbc);
    }
    @Test void anonymousAndMalformedKeyAreRejectedBeforeProjectAccessOrBodyCreation() {
        UserContext.clear();assertEquals(ErrorCode.UNAUTHORIZED,assertThrows(BizException.class,()->create(KEY)).getErrorCode());
        UserContext.set(7L,"creator");
        for(String key:List.of("","bad",KEY+" "))
            assertEquals(ErrorCode.PARAM_ERROR,assertThrows(BizException.class,()->create(key)).getErrorCode());
        verifyNoInteractions(jdbc,projects,documents);
    }
    @Test void deniedInactiveOrMissingProjectDoesNotCreateBodyOrAssociationOrSuccessfulReceipt() {
        for(ErrorCode code:List.of(ErrorCode.FORBIDDEN,ErrorCode.NOT_FOUND,ErrorCode.PARAM_ERROR)) {
            doThrow(new BizException(code)).when(projects).lockForDocumentCreation(10);
            assertEquals(code,assertThrows(BizException.class,()->create(KEY)).getErrorCode());
        }
        verifyNoInteractions(documents);verify(projects,never()).add(anyLong(),anyLong());
        verify(jdbc,never()).update(startsWith("UPDATE"),any(),any(),any(),any());
    }
    @Test void documentValidationFailureDoesNotTryToAddOrSaveSuccessfulReceipt() {
        doThrow(new BizException(ErrorCode.PARAM_ERROR)).when(documents).create(" 原始标题 ",0,null);
        assertEquals(ErrorCode.PARAM_ERROR,assertThrows(BizException.class,()->create(KEY)).getErrorCode());
        verify(projects).lockForDocumentCreation(10);verify(projects,never()).add(anyLong(),anyLong());
        verify(jdbc,never()).update(startsWith("UPDATE"),any(),any(),any(),any());
    }
    @Test void failedOrUnexpectedlyExistingAssociationFailsTheWholeCreationRatherThanReturningAnOrphan() {
        when(projects.add(10,41)).thenReturn(new ProjectService.Change(false));
        assertThrows(IllegalStateException.class,()->create(KEY));
        doThrow(new DataAccessResourceFailureException("association failed")).when(projects).add(10,41);
        assertThrows(DataAccessResourceFailureException.class,()->create(KEY));
        verify(jdbc,never()).update(startsWith("UPDATE"),any(),any(),any(),any());
    }
    @Test void receiptPersistenceFailurePropagatesForTransactionRollbackAfterAssociation() {
        doThrow(new DataAccessResourceFailureException("receipt failed")).when(jdbc).update(startsWith("UPDATE"),any(),any(),any(),any());
        assertThrows(DataAccessResourceFailureException.class,()->create(KEY));
        verify(projects).lockForDocumentCreation(10);verify(documents).create(" 原始标题 ",0,null);verify(projects).add(10,41);
    }
    @Test void actualDocumentServiceRejectsUnknownTemplateBeforeWritingAnyBody() {
        var repository=mock(DocumentRepository.class);
        var actual=new ProjectDocumentCreations(requests,new DocumentService(repository,mapper),projects);
        assertEquals(ErrorCode.PARAM_ERROR,assertThrows(BizException.class,()->actual.execute(KEY,10,"标题","unknown-template")).getErrorCode());
        verify(projects).lockForDocumentCreation(10);verify(projects,never()).add(anyLong(),anyLong());
        verifyNoInteractions(repository);verify(jdbc,never()).update(startsWith("UPDATE"),any(),any(),any(),any());
    }
    @Test void actualDocumentCreationBindsCurrentOwnerAndStoresTemplateBaselineBeforeAssociation() {
        var repository=mock(DocumentRepository.class);
        when(repository.create(eq("会议纪要"),eq(7L),eq(0L),anyString())).thenReturn(52L);
        when(repository.find(52)).thenReturn(Optional.of(new DocumentRepository.DocumentRow(52,"会议纪要","{}",0,7,"creator",0,LocalDateTime.of(2026,10,16,10,0))));
        var actual=new ProjectDocumentCreations(requests,new DocumentService(repository,mapper),projects);
        assertEquals(new ProjectDocumentCreations.Created(52,10,"会议纪要"),actual.execute(KEY,10,null,"meeting"));
        var order=inOrder(projects,repository);order.verify(projects).lockForDocumentCreation(10);
        order.verify(repository).create(eq("会议纪要"),eq(7L),eq(0L),contains("会议主题"));
        order.verify(repository).saveInitialSnapshot(eq(52L),contains("会议主题"));
        order.verify(repository).find(52);order.verify(projects).add(10,52);
        verify(repository,never()).addCollaborator(anyLong(),anyLong(),anyInt());
        verify(repository,never()).changeCollaborator(anyLong(),anyLong(),anyInt());
        verify(repository,never()).removeCollaborator(anyLong(),anyLong());
    }
    @Test void existingReceiptTransactionCoversRequiredProjectLocksDocumentCreationAndAssociation() throws Exception {
        var source=new AnnotationTransactionAttributeSource();
        var receipt=source.getTransactionAttribute(DocumentCreationRequests.class.getMethod("execute",String.class,String.class,Object.class,Class.class,Supplier.class),DocumentCreationRequests.class);
        assertNotNull(receipt);assertEquals(TransactionDefinition.ISOLATION_READ_COMMITTED,receipt.getIsolationLevel());
        assertFalse(receipt.isReadOnly());assertEquals(TransactionDefinition.PROPAGATION_REQUIRED,receipt.getPropagationBehavior());
        assertTrue(receipt.rollbackOn(new IllegalStateException("association failed")));
        assertTrue(receipt.rollbackOn(new DataAccessResourceFailureException("receipt failed")));
        for(var method:List.of(ProjectService.class.getMethod("lockForDocumentCreation",long.class),ProjectService.class.getMethod("add",long.class,long.class),
                DocumentService.class.getMethod("create",String.class,long.class,String.class))) {
            var joined=source.getTransactionAttribute(method,method.getDeclaringClass());
            assertNotNull(joined);assertFalse(joined.isReadOnly());assertEquals(TransactionDefinition.PROPAGATION_REQUIRED,joined.getPropagationBehavior());
        }
    }
}
