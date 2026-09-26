package com.school.collab.collab.store;

import com.school.collab.ot.Delta;

/** 某篇文档在一个确定 revision 上的内容快照。 */
public record CollabDocumentSnapshot(long revision, Delta content) {
}
