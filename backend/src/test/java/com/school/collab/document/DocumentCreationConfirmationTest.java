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

import java.sql.ResultSet;
import java.util.List;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class DocumentCreationConfirmationTest {
    private static final String KEY="12345678-abcd-4123-8123-123456789abc";
    private final JdbcTemplate jdbc=mock(JdbcTemplate.class);
    private final DocumentCreationRequests service=new DocumentCreationRequests(jdbc,new ObjectMapper());
    private String kind="document",response="{\"id\":41,\"title\":\"原名称\"}",title="后来改名";
    private long document=41;
    private boolean available=true,deleted=false;

    @BeforeEach void setup() throws Exception {
        UserContext.set(7L,"owner");
        doAnswer(call->{
            if (!Long.valueOf(7L).equals(call.getArgument(2)) || !KEY.equals(call.getArgument(3))) return List.of();
            var rs=mock(ResultSet.class);
            when(rs.getString(1)).thenReturn(kind);when(rs.getLong(2)).thenReturn(document);
            when(rs.getString(3)).thenReturn(response);when(rs.getObject(4)).thenReturn(available?document:null);
            when(rs.getString(5)).thenReturn(available?title:null);when(rs.getBoolean(6)).thenReturn(deleted);
            return List.of(((RowMapper<?>)call.getArgument(1)).mapRow(rs,0));
        }).when(jdbc).query(anyString(),any(RowMapper.class),any(),any());
    }
    @AfterEach void clear() { UserContext.clear(); }
    private void onlyReads() {
        assertTrue(mockingDetails(jdbc).getInvocations().stream().allMatch(i->i.getMethod().getName().equals("query")));
    }
    @Test void confirmsOriginalReceiptAndCurrentTitleWithoutReturningOldBodyOrWriting() {
        var result=service.confirm(KEY.toUpperCase());
        assertEquals(new DocumentCreationRequests.Confirmation(KEY,"document",41,true,"后来改名",false),result);
        verify(jdbc).query(anyString(),any(RowMapper.class),eq(7L),eq(KEY));onlyReads();
    }
    @Test void sameIdentifierInAnotherAccountDoesNotRevealTheOwnerReceipt() {
        UserContext.set(8L,"peer");
        assertEquals(ErrorCode.NOT_FOUND,assertThrows(BizException.class,()->service.confirm(KEY)).getErrorCode());
        verify(jdbc).query(anyString(),any(RowMapper.class),eq(8L),eq(KEY));onlyReads();
    }
    @Test void missingReceiptDoesNotCreateAReplacementOrClaimTheOriginalNeverCompleted() {
        var failure=assertThrows(BizException.class,()->service.confirm("99999999-1234-4123-8123-123456789abc"));
        assertEquals(ErrorCode.NOT_FOUND,failure.getErrorCode());assertTrue(failure.getMessage().contains("稍后"));onlyReads();
    }
    @Test void deletedDocumentIsConfirmedWithoutRestoringIt() {
        deleted=true;
        var result=service.confirm(KEY);assertTrue(result.available());assertTrue(result.deleted());assertEquals(41,result.id());onlyReads();
    }
    @Test void unavailableCurrentDocumentKeepsHistoricalReceiptButHidesCurrentMetadata() {
        available=false;deleted=true;
        var result=service.confirm(KEY);assertEquals(41,result.id());assertFalse(result.available());
        assertFalse(result.deleted());assertNull(result.title());onlyReads();
    }
    @Test void invalidOrIncompleteReceiptCannotBeReportedAsAConfirmedCreation() {
        for(String bad:List.of("","invalid","null","[]","{\"id\":42}","{\"id\":41.0}","{\"id\":\"41\"}","{\"id\":41} {}")) {
            response=bad;assertThrows(IllegalStateException.class,()->service.confirm(KEY));
        }
        response="{\"id\":41}";document=0;assertThrows(IllegalStateException.class,()->service.confirm(KEY));onlyReads();
    }
    @Test void anonymousAndMalformedRequestsDoNotQueryAnything() {
        UserContext.clear();assertEquals(ErrorCode.UNAUTHORIZED,assertThrows(BizException.class,()->service.confirm(KEY)).getErrorCode());
        UserContext.set(7L,"owner");
        for(String key:new String[]{null,""," ","not-a-uuid","1-1-1-1-1",KEY+" "})
            assertEquals(ErrorCode.PARAM_ERROR,assertThrows(BizException.class,()->service.confirm(key)).getErrorCode());
        verifyNoInteractions(jdbc);
    }
}
