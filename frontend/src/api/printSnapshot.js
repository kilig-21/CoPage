const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const documentId = value => Number.isSafeInteger(value) && value > 0
const invalidSnapshot = () => new Error('打印预览回复不完整或格式不符，尚未生成打印副本。请刷新预览，原文档仍保留。')

// 打印读取的是存量全文；只核对结构，不套用导入的容量/片段限制或改写正文。
export function parsePrintSnapshot(reply, expectedId) {
  const value = reply?.data
  if (!record(reply) || reply.code !== 0 || !documentId(expectedId) || !record(value) ||
      value.id !== expectedId || typeof value.title !== 'string' || !value.title.trim() ||
      !Number.isSafeInteger(value.revision) || value.revision < 0 || !record(value.content) ||
      !Array.isArray(value.content.ops) || !value.content.ops.length) throw invalidSnapshot()
  for (const op of value.content.ops) {
    if (!record(op) || !Object.hasOwn(op, 'insert') ||
        Object.keys(op).some(key => !['insert', 'attributes'].includes(key))) throw invalidSnapshot()
    if (typeof op.insert === 'string') {
      if (!op.insert.length) throw invalidSnapshot()
    } else if (!record(op.insert) || Object.keys(op.insert).length !== 1 ||
        typeof op.insert.image !== 'string' || !op.insert.image.length) throw invalidSnapshot()
    if (Object.hasOwn(op, 'attributes') && (!record(op.attributes) ||
        Object.values(op.attributes).some(value => value !== null &&
          !['string', 'boolean'].includes(typeof value) && !(typeof value === 'number' && Number.isFinite(value))))) {
      throw invalidSnapshot()
    }
  }
  const last = value.content.ops.at(-1).insert
  if (typeof last !== 'string' || !last.endsWith('\n')) throw invalidSnapshot()
  return value
}

export function confirmPrintAccess(reply, expectedId) {
  if (!record(reply) || reply.code !== 0 || !documentId(expectedId) ||
      !record(reply.data) || reply.data.id !== expectedId) {
    throw new Error('打印权限回复无法确认，尚未打开打印窗口。请重试，原文档仍保留。')
  }
}
