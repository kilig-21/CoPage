package com.school.collab.collab.store;

import com.school.collab.ot.Delta;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Supplier;

/** 不注册为 Spring Bean，仅供纯单元测试使用。 */
public final class InMemoryDocumentStateStore implements DocumentStateStore {

    private final ConcurrentMap<Long, State> documents = new ConcurrentHashMap<>();

    @Override
    public CollabDocumentSnapshot snapshot(long docId) {
        State state = stateFor(docId);
        state.lock.lock();
        try {
            return new CollabDocumentSnapshot(state.revision, state.content.copy());
        } finally {
            state.lock.unlock();
        }
    }

    @Override
    public long minimumAvailableBaseRevision(long docId) {
        State state = stateFor(docId);
        state.lock.lock();
        try {
            return state.history.isEmpty() ? 0 : state.history.getFirst().revision() - 1;
        } finally {
            state.lock.unlock();
        }
    }

    @Override
    public List<VersionedOperation> operationsAfter(long docId, long revision) {
        State state = stateFor(docId);
        state.lock.lock();
        try {
            return state.history.stream()
                    .filter(item -> item.revision() > revision)
                    .map(item -> new VersionedOperation(item.revision(), item.operation().copy()))
                    .toList();
        } finally {
            state.lock.unlock();
        }
    }

    @Override
    public void save(long docId, CollabDocumentSnapshot snapshot, VersionedOperation operation, int historyLimit) {
        State state = stateFor(docId);
        state.content = snapshot.content().copy();
        state.revision = snapshot.revision();
        state.history.addLast(new VersionedOperation(operation.revision(), operation.operation().copy()));
        while (state.history.size() > historyLimit) {
            state.history.removeFirst();
        }
    }

    @Override
    public <T> T withDocumentLock(long docId, Supplier<T> action) {
        State state = stateFor(docId);
        state.lock.lock();
        try {
            return action.get();
        } finally {
            state.lock.unlock();
        }
    }

    private State stateFor(long docId) {
        return documents.computeIfAbsent(docId, ignored -> new State());
    }

    private static final class State {
        private final ReentrantLock lock = new ReentrantLock();
        private final Deque<VersionedOperation> history = new ArrayDeque<>();
        private Delta content = new Delta().insert("\n");
        private long revision;
    }
}
