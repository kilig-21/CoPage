import CollabClient from '../ws/CollabClient.js'

function checkOperationStructure(delta) {
  for (const op of delta.ops) {
    if (!op || typeof op !== 'object' || Array.isArray(op)) throw new Error('草稿操作结构无效')
    const actions = ['insert', 'retain', 'delete'].filter(key => Object.hasOwn(op, key))
    if (actions.length !== 1 || Object.keys(op).some(key => ![...actions, 'attributes'].includes(key))) {
      throw new Error('草稿操作结构无效')
    }
    if (actions[0] === 'insert') {
      const value = op.insert
      if (!(typeof value === 'string' && value.length > 0) &&
          !(value && typeof value === 'object' && Object.keys(value).length === 1 && typeof value.image === 'string')) {
        throw new Error('草稿插入内容无法识别')
      }
    } else if (!Number.isSafeInteger(op[actions[0]]) || op[actions[0]] <= 0) {
      throw new Error('草稿操作长度无效')
    }
    if (Object.hasOwn(op, 'attributes') && (!op.attributes || typeof op.attributes !== 'object' ||
        Array.isArray(op.attributes) || actions[0] === 'delete')) throw new Error('草稿格式结构无效')
  }
}

export function readDraftRecords({ storage, prefix, docId, Delta }) {
  const drafts = []
  const unreadable = []
  if (!prefix) return { drafts, unreadable }
  // 用独立客户端的既有恢复校验；不修改当前编辑器或开始连接。
  const validator = new CollabClient({ docId, Delta })
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index)
    if (!key?.startsWith(prefix)) continue
    const raw = storage.getItem(key)
    if (raw === null) continue
    try {
      const draft = JSON.parse(raw)
      const content = validator.restoreDraft(draft)
      for (const delta of [draft.content, draft.pending?.original, draft.pending?.delta, draft.buffer].filter(Boolean)) {
        checkOperationStructure(delta)
      }
      // diff 要求完整正文仅含 insert；不能把损坏的操作流传给 Quill。
      content.diff(new Delta().insert('\n'))
      if (typeof content.ops.at(-1)?.insert !== 'string' || !content.ops.at(-1).insert.endsWith('\n')) {
        throw new Error('草稿正文结构无效')
      }
      if (key !== prefix + draft.clientId) throw new Error('草稿标识与存储槽位不匹配')
      drafts.push({ key, draft })
    } catch {
      unreadable.push({ key, raw })
    }
  }
  return { drafts, unreadable }
}

export function draftRecordsJson(docId, records) {
  return JSON.stringify({ format: 'copage-draft-records', version: 1, docId,
    records: records.map(({ key, raw }) => ({ key, raw })) }, null, 2)
}
