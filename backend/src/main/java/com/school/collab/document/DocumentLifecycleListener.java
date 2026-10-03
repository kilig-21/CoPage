package com.school.collab.document;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.collab.ws.CollabEventBus;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionalEventListener;

/** 删除事务提交后通知所有实例逐次查权限，不在消息中携带正文。 */
@Component
public class DocumentLifecycleListener {
    private static final Logger log=LoggerFactory.getLogger(DocumentLifecycleListener.class);
    private final CollabEventBus events;
    private final ObjectMapper mapper;
    public DocumentLifecycleListener(CollabEventBus events,ObjectMapper mapper) {this.events=events;this.mapper=mapper;}

    @TransactionalEventListener
    public void deleted(DocumentService.DocumentDeleted event) {
        try { events.publish(event.docId(),"",mapper.createObjectNode().put("type","permission").put("docId",event.docId())); }
        catch(RuntimeException ex) {log.warn("文档已移入回收站，连接通知暂时失败，将由心跳补偿, docId={}",event.docId());}
    }
}
