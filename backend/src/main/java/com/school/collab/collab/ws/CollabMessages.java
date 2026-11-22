package com.school.collab.collab.ws;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.school.collab.collab.presence.RedisPresenceStore.PresenceUser;
import com.school.collab.collab.store.VersionedOperation;

import java.util.List;

public final class CollabMessages {
    private CollabMessages() { }

    public static ObjectNode presence(ObjectMapper mapper, long docId, List<PresenceUser> users) {
        var payload = mapper.createObjectNode().put("type", "presence").put("docId", docId);
        payload.set("users", mapper.valueToTree(users));
        return payload;
    }

    static void appendHistory(ObjectMapper mapper, ObjectNode payload, List<VersionedOperation> operations) {
        var history = payload.putArray("history");
        operations.forEach(entry -> history.addObject().put("revision", entry.revision())
                .set("op", mapper.valueToTree(entry.operation())));
    }
}
