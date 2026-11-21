package com.school.collab.observability;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.RedisScript;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.util.List;

import static com.school.collab.observability.FrontendErrorController.PATH;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class FrontendErrorControllerTest {
    private static final String ORIGIN = "https://frontend.example.invalid";
    private static final String BODY = """
            {"source":"render","route":"/docs/:id","kind":"TypeError","environment":"production",
            "release":"0123456789abcdef0123456789abcdef01234567"}
            """;
    private final StringRedisTemplate redis = mock(StringRedisTemplate.class);

    private MockMvc mvc(boolean enabled) {
        return MockMvcBuilders.standaloneSetup(new FrontendErrorController(new ObjectMapper(), redis, ORIGIN, enabled, 60))
                .build();
    }

    @Test
    void acceptsOnlyTheCanonicalReportAndRequiresNoUserSession() throws Exception {
        when(redis.execute(org.mockito.ArgumentMatchers.<RedisScript<Long>>any(),
                eq(List.of("collab:telemetry:frontend-errors")), eq("60"))).thenReturn(1L);
        mvc(true).perform(post(PATH).header("Origin", ORIGIN).contentType(MediaType.APPLICATION_JSON).content(BODY))
                .andExpect(status().isNoContent());
    }

    @Test
    void disabledEndpointAndUntrustedOriginHaveNoRedisSideEffects() throws Exception {
        mvc(false).perform(post(PATH).header("Origin", ORIGIN).contentType(MediaType.APPLICATION_JSON).content(BODY))
                .andExpect(status().isNotFound());
        mvc(true).perform(post(PATH).header("Origin", "https://external.example.invalid")
                .contentType(MediaType.APPLICATION_JSON).content(BODY)).andExpect(status().isForbidden());
        verifyNoInteractions(redis);
    }

    @Test
    void malformedExtraAndSensitiveFieldsAreRejectedWithoutLoggingOrTakingQuota() throws Exception {
        MockMvc server = mvc(true);
        for (String invalid : List.of("", "{}", BODY + "{}", BODY.replace("/docs/:id", "/docs/123?token=fake"),
                BODY.replace("TypeError", "user_account"), BODY.replace("production", "secret-room"),
                BODY.replace("\"source\":", "\"source\":\"rejection\",\"source\":"),
                BODY.replace("}", ",\"token\":\"private\"}"))) {
            server.perform(post(PATH).header("Origin", ORIGIN).contentType(MediaType.APPLICATION_JSON).content(invalid))
                    .andExpect(status().isBadRequest());
        }
        server.perform(post(PATH).header("Origin", ORIGIN).contentType(MediaType.APPLICATION_JSON).content("x".repeat(513)))
                .andExpect(status().isPayloadTooLarge());
        verifyNoInteractions(redis);
    }

    @Test
    void quotaAndUnavailableRedisHaveBoundedEmptyResponses() throws Exception {
        when(redis.execute(org.mockito.ArgumentMatchers.<RedisScript<Long>>any(), any(), eq("60")))
                .thenReturn(0L).thenThrow(new IllegalStateException("private credentials"));
        MockMvc server = mvc(true);
        server.perform(post(PATH).header("Origin", ORIGIN).contentType(MediaType.APPLICATION_JSON).content(BODY))
                .andExpect(status().isTooManyRequests());
        server.perform(post(PATH).header("Origin", ORIGIN).contentType(MediaType.APPLICATION_JSON).content(BODY))
                .andExpect(status().isServiceUnavailable());
    }
}
