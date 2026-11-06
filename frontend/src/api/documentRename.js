const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)

// 核对当前事实必须指向原文档；写入确认还须对应本次提交的标题。
export function parseDocumentRenameReply(reply, docId, expectedTitle) {
  if (!Number.isSafeInteger(docId) || docId <= 0 || !record(reply) || reply.code !== 0 ||
      !record(reply.data) || reply.data.id !== docId || typeof reply.data.title !== 'string' ||
      !reply.data.title.trim() || reply.data.title.length > 200 ||
      (expectedTitle !== undefined && reply.data.title !== expectedTitle)) {
    throw new Error('文档标题回复无法确认，请重新核对；当前输入仍保留。')
  }
  return reply.data
}
