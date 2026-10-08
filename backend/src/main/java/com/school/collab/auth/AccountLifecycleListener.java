package com.school.collab.auth;

import com.school.collab.collab.ws.CollabEventBus;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionalEventListener;

@Component
public class AccountLifecycleListener {
    private static final Logger log=LoggerFactory.getLogger(AccountLifecycleListener.class);
    private final CollabEventBus events;
    public AccountLifecycleListener(CollabEventBus events) { this.events=events; }
    @TransactionalEventListener
    public void passwordChanged(AccountService.PasswordChanged event) {
        try { events.publishAccountChanged(event.userId()); }
        catch(RuntimeException exception) {
            log.warn("密码已更新，旧连接通知暂时失败，后续请求及心跳仍校验当前凭据版本, userId={}",event.userId());
        }
    }
}
