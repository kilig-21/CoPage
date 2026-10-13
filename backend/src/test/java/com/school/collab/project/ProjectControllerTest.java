package com.school.collab.project;

import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

class ProjectControllerTest {
    @Test void projectStateRouteBindsOriginalIdAndReturnsMetadataOnly() throws Exception {
        var service=mock(ProjectService.class);
        when(service.state(10)).thenReturn(new ProjectService.StateView(10,3,"项目","简介",true,false));
        MockMvcBuilders.standaloneSetup(new ProjectController(service,mock(ProjectCreationRequests.class))).build().perform(get("/api/projects/10/state"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.code").value(0))
            .andExpect(jsonPath("$.data.id").value(10)).andExpect(jsonPath("$.data.groupId").value(3))
            .andExpect(jsonPath("$.data.archived").value(true)).andExpect(jsonPath("$.data.canManage").value(false))
            .andExpect(jsonPath("$.data.content").doesNotExist());
        verify(service).state(10);verifyNoMoreInteractions(service);
    }
    @Test void associationStateRouteBindsBothIdsAndPreservesAnAbsentAssociation() throws Exception {
        var service=mock(ProjectService.class);
        when(service.associationState(10,5)).thenReturn(new ProjectService.AssociationStateView(10,5,"资料",null,true));
        MockMvcBuilders.standaloneSetup(new ProjectController(service,mock(ProjectCreationRequests.class))).build().perform(get("/api/projects/10/documents/5/state"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.code").value(0))
            .andExpect(jsonPath("$.data.projectId").value(10)).andExpect(jsonPath("$.data.docId").value(5))
            .andExpect(jsonPath("$.data.docTitle").value("资料")).andExpect(jsonPath("$.data.projectArchived").value(true))
            .andExpect(jsonPath("$.data.associationId").value(org.hamcrest.Matchers.nullValue()))
            .andExpect(jsonPath("$.data.content").doesNotExist());
        verify(service).associationState(10,5);verifyNoMoreInteractions(service);
    }
    @Test void creationBindsOptionalHeaderAndOriginalPayloadWithoutChangingTheResponse() throws Exception {
        var projects=mock(ProjectService.class);var creations=mock(ProjectCreationRequests.class);
        String key="12345678-1234-4123-8123-123456789abc";
        when(creations.execute(key," 项目 ","简介",3)).thenReturn(new ProjectService.IdView(10,3));
        MockMvcBuilders.standaloneSetup(new ProjectController(projects,creations)).build()
            .perform(post("/api/projects").header("Idempotency-Key",key).contentType("application/json")
                .content("{\"name\":\" 项目 \",\"description\":\"简介\",\"groupId\":3}"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.data.id").value(10)).andExpect(jsonPath("$.data.groupId").value(3));
        verify(creations).execute(key," 项目 ","简介",3);verifyNoMoreInteractions(creations);verifyNoInteractions(projects);
    }
    @Test void legacyCreationKeepsMissingHeaderAndDefaultsPersonalGroupToZero() throws Exception {
        var projects=mock(ProjectService.class);var creations=mock(ProjectCreationRequests.class);
        when(creations.execute(null,"项目",null,0)).thenReturn(new ProjectService.IdView(10,0));
        MockMvcBuilders.standaloneSetup(new ProjectController(projects,creations)).build()
            .perform(post("/api/projects").contentType("application/json").content("{\"name\":\"项目\"}"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.data.id").value(10)).andExpect(jsonPath("$.data.groupId").value(0));
        verify(creations).execute(null,"项目",null,0);verifyNoMoreInteractions(creations);verifyNoInteractions(projects);
    }
}
