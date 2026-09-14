package com.school.collab.config;

import org.springframework.amqp.core.Binding;
import org.springframework.amqp.core.BindingBuilder;
import org.springframework.amqp.core.Queue;
import org.springframework.amqp.core.QueueBuilder;
import org.springframework.amqp.core.TopicExchange;
import org.springframework.amqp.support.converter.Jackson2JsonMessageConverter;
import org.springframework.amqp.support.converter.MessageConverter;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * 文档操作的异步落库通道。
 * 交换机、队列、绑定都在这里声明 —— 队列如果只由生产端临时声明，
 * 消费端尚未启动时消息会被 broker 直接丢弃且不报错，是最难排查的一类问题。
 */
@Configuration
public class RabbitMqConfig {

    public static final String DOC_EXCHANGE = "collab.doc";

    public static final String OP_QUEUE = "doc.op.persist.queue";
    public static final String OP_ROUTING_KEY = "doc.op.persist";

    public static final String SNAPSHOT_QUEUE = "doc.snapshot.queue";
    public static final String SNAPSHOT_ROUTING_KEY = "doc.snapshot";

    /** 死信通道：消费失败并 nack 的消息落这里，不直接丢。 */
    public static final String DLX_EXCHANGE = "collab.doc.dlx";
    public static final String DLQ_QUEUE = "doc.dead.queue";

    @Bean
    public TopicExchange docExchange() {
        return new TopicExchange(DOC_EXCHANGE, true, false);
    }

    @Bean
    public Queue opPersistQueue() {
        return QueueBuilder.durable(OP_QUEUE).deadLetterExchange(DLX_EXCHANGE).build();
    }

    @Bean
    public Binding opPersistBinding() {
        return BindingBuilder.bind(opPersistQueue()).to(docExchange()).with(OP_ROUTING_KEY);
    }

    @Bean
    public Queue snapshotQueue() {
        return QueueBuilder.durable(SNAPSHOT_QUEUE).deadLetterExchange(DLX_EXCHANGE).build();
    }

    @Bean
    public Binding snapshotBinding() {
        return BindingBuilder.bind(snapshotQueue()).to(docExchange()).with(SNAPSHOT_ROUTING_KEY);
    }

    @Bean
    public TopicExchange deadLetterExchange() {
        return new TopicExchange(DLX_EXCHANGE, true, false);
    }

    @Bean
    public Queue deadLetterQueue() {
        return QueueBuilder.durable(DLQ_QUEUE).build();
    }

    @Bean
    public Binding deadLetterBinding() {
        return BindingBuilder.bind(deadLetterQueue()).to(deadLetterExchange()).with("#");
    }

    /**
     * 消息体用 JSON 而不是 JDK 序列化：JDK 序列化要求消息类实现 Serializable，
     * 且发出去以后没法用管理台直接读，排查问题很费劲。
     */
    @Bean
    public MessageConverter jsonMessageConverter() {
        return new Jackson2JsonMessageConverter();
    }
}
