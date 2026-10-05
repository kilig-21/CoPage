export function createDraftBackup({ docId, username, title, content }) {
  return {
    docId, username, title: title || `文档 ${docId}`, savedAt: Date.now(),
    content: JSON.parse(JSON.stringify(content)),
  }
}

export function draftBackupJson(backup) {
  return JSON.stringify({ format: 'copage', version: 1, title: backup.title, content: backup.content })
}

export function draftBackupText(backup) {
  return backup.content.ops.map(op => typeof op.insert === 'string' ? op.insert
    : op.insert?.image ? `[图片：${op.insert.image}]` : '').join('')
}
