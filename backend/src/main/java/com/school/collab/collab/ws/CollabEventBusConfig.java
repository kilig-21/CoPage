package com.school.collab.collab.ws;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.listener.ChannelTopic;
import org.springframework.data.redis.listener.RedisMessageListenerContainer;

@Configuration
public class CollabEventBusConfig {
    @Bean
    public RedisMessageListenerContainer collabMessageListenerContainer(
            RedisConnectionFactory connectionFactory, CollabEventBus eventBus
    ) {
        RedisMessageListenerContainer container = new RedisMessageListenerContainer();
        container.setConnectionFactory(connectionFactory);
        container.addMessageListener(eventBus, new ChannelTopic(CollabEventBus.CHANNEL));
        return container;
    }
}
