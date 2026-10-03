package com.school.collab.document;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.school.collab.collab.ws.CollabEventBus;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionalEventListener;

/** 事务提交后通知所有实例；仅发送失效通知，接收方按当前权限重新读取。 */
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

    @TransactionalEventListener
    public void renamed(DocumentService.DocumentRenamed event) {
        try { events.publish(event.docId(), "", mapper.createObjectNode().put("type", "metadata").put("docId", event.docId())); }
        catch (RuntimeException ex) { log.warn("文档标题已保存，通知暂时失败，重连时将重新读取, docId={}", event.docId()); }
    }
}
