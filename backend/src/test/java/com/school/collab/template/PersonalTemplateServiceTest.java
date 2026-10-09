package com.school.collab.template;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.common.BizException;
import com.school.collab.common.ErrorCode;
import com.school.collab.common.UserContext;
import com.school.collab.document.DocumentService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import java.util.List;
import java.util.Optional;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;

class PersonalTemplateServiceTest {
    private static final String BODY="{\"ops\":[{\"insert\":\"框架\\n\"}]}";
    private final PersonalTemplateRepository repo=mock(PersonalTemplateRepository.class);
    private final DocumentService documents=mock(DocumentService.class);
    private final PersonalTemplateService service=new PersonalTemplateService(repo,documents,new ObjectMapper());
    private final PersonalTemplateRepository.Template template=new PersonalTemplateRepository.Template(10,1,"我的框架","说明","learning",BODY,7,3);
    @AfterEach void clear(){UserContext.clear();}
    private void as(long id){UserContext.set(id,"user"+id);}
    private void code(ErrorCode code,Runnable action){assertEquals(code,assertThrows(BizException.class,action::run).getErrorCode());}
    private void source(int permission){as(1);when(repo.source(20,1)).thenReturn(Optional.of(new PersonalTemplateRepository.Source(BODY,7,permission)));
        when(repo.usage(1)).thenReturn(new PersonalTemplateRepository.Usage(0,0));}
    private void existing(){as(1);when(repo.find(eq(10L),anyBoolean())).thenReturn(Optional.of(template));}

    @Test void anonymousNeverReadsOrWritesPrivateTemplates(){
        code(ErrorCode.UNAUTHORIZED,()->service.list("all","",1,20));
        code(ErrorCode.UNAUTHORIZED,()->service.detail(10));
        code(ErrorCode.UNAUTHORIZED,()->service.create(20,"名称","","learning"));
        code(ErrorCode.UNAUTHORIZED,()->service.update(10,"名称","","learning",3));
        code(ErrorCode.UNAUTHORIZED,()->service.delete(10,3));
        code(ErrorCode.UNAUTHORIZED,()->service.instantiate(10,"文档",3));
        verifyNoInteractions(repo,documents);
    }
    @Test void invalidFieldsDoNotReadSourceOrWriteQuota(){
        as(1);
        for(String name:new String[]{null," ","名".repeat(201),"a\nb"})code(ErrorCode.PARAM_ERROR,()->service.create(20,name,"","learning"));
        for(String category:new String[]{null,"all","invalid"})code(ErrorCode.PARAM_ERROR,()->service.create(20,"名","",category));
        code(ErrorCode.PARAM_ERROR,()->service.create(20,"名","说".repeat(301),"learning"));
        code(ErrorCode.PARAM_ERROR,()->service.create(0,"名","","learning"));
        verifyNoInteractions(repo,documents);
    }
    @Test void currentlyUnreadableOrDeletedSourceCannotBecomeTemplate(){
        source(0);code(ErrorCode.FORBIDDEN,()->service.create(20,"名","","learning"));
        when(repo.source(20,1)).thenReturn(Optional.empty());code(ErrorCode.NOT_FOUND,()->service.create(20,"名","","learning"));
        verify(repo,never()).usage(anyLong());verify(repo,never()).create(anyLong(),anyString(),anyString(),anyString(),anyString(),anyInt(),anyLong());
        verifyNoInteractions(documents);
    }
    @Test void readonlySourceBecomesIndependentPrivateSnapshotOfSavedRevision(){
        source(1);when(repo.create(eq(1L),eq("名称"),eq("说明"),eq("learning"),eq(BODY),anyInt(),eq(7L))).thenReturn(11L);
        var result=service.create(20," 名称 "," 说明 ","learning");
        assertEquals(11,result.id());assertEquals(7,result.sourceRevision());
        verify(repo).create(1,"名称","说明","learning",BODY,BODY.getBytes(java.nio.charset.StandardCharsets.UTF_8).length,7);
        verifyNoInteractions(documents);
    }
    @Test void quotaAndSourceAreLockedBeforeReadingCurrentUsage(){
        source(2);service.create(20,"名","","learning");
        var order=inOrder(repo);order.verify(repo).lockOwner(1);order.verify(repo).source(20,1);order.verify(repo).usage(1);
        order.verify(repo).create(eq(1L),eq("名"),eq(""),eq("learning"),eq(BODY),anyInt(),eq(7L));
    }
    @Test void countAndByteQuotaRejectWithoutSavingTemplate(){
        source(2);when(repo.usage(1)).thenReturn(new PersonalTemplateRepository.Usage(100,0));
        code(ErrorCode.PARAM_ERROR,()->service.create(20,"名","","learning"));
        when(repo.usage(1)).thenReturn(new PersonalTemplateRepository.Usage(1,32L*1024*1024));
        code(ErrorCode.PARAM_ERROR,()->service.create(20,"名","","learning"));
        verify(repo,never()).create(anyLong(),anyString(),anyString(),anyString(),anyString(),anyInt(),anyLong());
    }
    @Test void malformedUnsafeOrOversizedStoredBodyCannotBeReused(){
        source(2);
        for(String body:new String[]{"{}", "{\"ops\":[]}", "{\"ops\":[{\"retain\":2}]}",
            "{\"ops\":[{\"insert\":\"无换行\"}]}","{\"ops\":[{\"insert\":{\"image\":\"javascript:alert(1)\"}}]}","字".repeat(1024*1024)}) {
            when(repo.source(20,1)).thenReturn(Optional.of(new PersonalTemplateRepository.Source(body,7,2)));
            code(ErrorCode.PARAM_ERROR,()->service.create(20,"名","","learning"));
        }
        verify(repo,never()).usage(anyLong());verify(repo,never()).create(anyLong(),anyString(),anyString(),anyString(),anyString(),anyInt(),anyLong());
    }
    @Test void storedJsonWhitespaceDoesNotRejectLegalBoundaryButLargerBodyIsRejected() {
        source(2);String empty="{\"ops\":[{\"insert\":\"\\n\"}]}";
        int limit=2*1024*1024,padding=limit-empty.getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
        String body="{\"ops\":[{\"insert\":\""+"x".repeat(padding)+"\\n\"}]}";
        when(repo.source(20,1)).thenReturn(Optional.of(new PersonalTemplateRepository.Source("   "+body+"   ",7,2)));
        service.create(20,"名","","learning");
        var captured=org.mockito.ArgumentCaptor.forClass(String.class);
        verify(repo).create(eq(1L),eq("名"),eq(""),eq("learning"),captured.capture(),eq(limit),eq(7L));
        assertTrue(body.equals(captured.getValue()),"保存的是规范正文，完整内容不变");
        String larger="{\"ops\":[{\"insert\":\""+"x".repeat(padding+1)+"\\n\"}]}";
        when(repo.source(20,1)).thenReturn(Optional.of(new PersonalTemplateRepository.Source(larger,7,2)));
        code(ErrorCode.PARAM_ERROR,()->service.create(20,"名","","learning"));
        verify(repo,times(1)).create(anyLong(),anyString(),anyString(),anyString(),anyString(),anyInt(),anyLong());
    }
    @Test void privateDetailAndCreationRejectOtherIdentity(){
        existing();as(2);code(ErrorCode.FORBIDDEN,()->service.detail(10));
        code(ErrorCode.FORBIDDEN,()->service.instantiate(10,"文档",3));verifyNoInteractions(documents);
        as(1);var d=service.detail(10);assertEquals("框架\n",d.content().path("ops").get(0).path("insert").asText());assertEquals(3,d.version());
    }
    @Test void metadataRequiresCurrentVersionAndNeverReplacesBody(){
        existing();code(ErrorCode.PARAM_ERROR,()->service.update(10,"新名","新说明","planning",2));
        verify(repo,never()).update(anyLong(),anyString(),anyString(),anyString());
        service.update(10," 新名 "," 新说明 ","planning",3);verify(repo).update(10,"新名","新说明","planning");
        verifyNoInteractions(documents);
    }
    @Test void deletionRequiresOwnerAndCurrentVersion(){
        existing();as(2);code(ErrorCode.FORBIDDEN,()->service.delete(10,3));as(1);
        code(ErrorCode.PARAM_ERROR,()->service.delete(10,2));verify(repo,never()).delete(anyLong());
        service.delete(10,3);verify(repo).delete(10);verifyNoInteractions(documents);
    }
    @Test void instantiationUsesIndependentDocumentPipelineAfterVersionCheck(){
        existing();code(ErrorCode.PARAM_ERROR,()->service.instantiate(10,"文档",2));verifyNoInteractions(documents);
        service.instantiate(10,null,3);verify(documents).createImported(eq("我的框架"),argThat(node->"框架\n".equals(node.path("ops").get(0).path("insert").asText())));
        verify(repo,never()).create(anyLong(),anyString(),anyString(),anyString(),anyString(),anyInt(),anyLong());
    }
    @Test void paginatedSummariesAndUsageAreScopedToCurrentOwner(){
        as(4);when(repo.list(4,"planning","需求",1,20)).thenReturn(List.of());when(repo.usage(4)).thenReturn(new PersonalTemplateRepository.Usage(2,1024));
        var result=service.list("planning"," 需求 ",1,20);assertEquals(2,result.usage().count());assertEquals(100,result.countLimit());
        verify(repo).count(4,"planning","需求");verify(repo).list(4,"planning","需求",1,20);
        code(ErrorCode.PARAM_ERROR,()->service.list("all","",0,20));
        code(ErrorCode.PARAM_ERROR,()->service.list("all","",1,101));
        code(ErrorCode.PARAM_ERROR,()->service.list("all","字".repeat(201),1,20));
    }
}
