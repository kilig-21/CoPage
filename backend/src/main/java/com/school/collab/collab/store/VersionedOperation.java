package com.school.collab.collab.store;

import com.school.collab.ot.Delta;

/** 服务端已全序化的一条 Delta 操作。 */
public record VersionedOperation(long revision, Delta operation) {
}
