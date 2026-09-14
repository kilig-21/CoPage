package com.school.collab.config;

import org.springframework.amqp.core.DirectExchange;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class RabbitMqConfig {
    public static final String DOC_EXCHANGE = "collab.doc";

    @Bean
    public DirectExchange docExchange() {
        return new DirectExchange(DOC_EXCHANGE, true, false);
    }
}
