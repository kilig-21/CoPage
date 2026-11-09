const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const success = reply => record(reply) && reply.code === 0
const target = (data, id) => Number.isSafeInteger(id) && id > 0 && record(data) && data.id === id &&
  typeof data.title === 'string' && Boolean(data.title.trim()) && data.title.length <= 200

// HTTP 200不代表业务成功；坏回复保留原目标，交给只读状态核对。
export function confirmDocumentDeletion(reply) {
  if (!success(reply) || reply.data !== null) throw new Error('删除回复无法确认')
}

export function parseDocumentRestoration(reply, id) {
  if (!success(reply) || !target(reply.data, id)) throw new Error('恢复回复无法确认')
  return reply.data
}

export function parseDocumentState(reply, id) {
  if (!success(reply) || !target(reply.data, id) || typeof reply.data.deleted !== 'boolean') {
    throw new Error('当前文档状态无法确认')
  }
  return reply.data
}
