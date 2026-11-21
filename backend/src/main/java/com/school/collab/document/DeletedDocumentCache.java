package com.school.collab.document;

import com.school.collab.collab.presence.RedisPresenceStore;
import com.school.collab.collab.store.RedisDocumentStateStore;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

@Service
public class DeletedDocumentCache {
    private final DocumentRepository documents;
    private final RedisDocumentStateStore state;
    private final RedisPresenceStore presence;

    public DeletedDocumentCache(DocumentRepository documents, RedisDocumentStateStore state,
                                RedisPresenceStore presence) {
        this.documents = documents;
        this.state = state;
        this.presence = presence;
    }

    /** Read the committed deletion state before evicting; hold the row against a concurrent restore. */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void clearIfDeleted(long docId) {
        state.withDocumentLock(docId, () -> {
            documents.lockDeletedRevision(docId).ifPresent(revision -> {
                presence.clear(docId);
                state.evictDurableState(docId, revision);
            });
            return null;
        });
    }
}
