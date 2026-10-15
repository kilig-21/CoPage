package com.school.collab.group;

import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

class GroupControllerTest {
    @Test void creationBindsOptionalHeaderAndOriginalPayloadAndReturnsCurrentArchivedState() throws Exception {
        var groups=mock(GroupService.class);var creations=mock(GroupCreationRequests.class);
        String key="12345678-1234-4123-8123-123456789abc";
        when(creations.execute(key," 小组 ","简介")).thenReturn(new GroupService.CreationView(10,true,"已改名的小组"));
        MockMvcBuilders.standaloneSetup(new GroupController(groups,creations)).build()
            .perform(post("/api/groups").header("Idempotency-Key",key).contentType("application/json")
                .content("{\"name\":\" 小组 \",\"description\":\"简介\",\"ownerId\":999}"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.data.id").value(10)).andExpect(jsonPath("$.data.archived").value(true))
            .andExpect(jsonPath("$.data.name").value("已改名的小组")).andExpect(jsonPath("$.data.members").doesNotExist());
        verify(creations).execute(key," 小组 ","简介");verifyNoMoreInteractions(creations);verifyNoInteractions(groups);
    }
    @Test void legacyCreationKeepsMissingHeaderAndNullDescription() throws Exception {
        var groups=mock(GroupService.class);var creations=mock(GroupCreationRequests.class);
        when(creations.execute(null,"小组",null)).thenReturn(new GroupService.CreationView(10,false,"小组"));
        MockMvcBuilders.standaloneSetup(new GroupController(groups,creations)).build()
            .perform(post("/api/groups").contentType("application/json").content("{\"name\":\"小组\"}"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.data.id").value(10)).andExpect(jsonPath("$.data.archived").value(false))
            .andExpect(jsonPath("$.data.name").value("小组"));
        verify(creations).execute(null,"小组",null);verifyNoMoreInteractions(creations);verifyNoInteractions(groups);
    }
}
