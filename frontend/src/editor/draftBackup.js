export function createDraftBackup({ docId, username, title, content }) {
  return {
    docId, username, title: title || `文档 ${docId}`, savedAt: Date.now(),
    content: JSON.parse(JSON.stringify(content)),
  }
}

export function draftBackupJson(backup) {
  return JSON.stringify({ format: 'copage', version: 1, title: backup.title, content: backup.content })
}

export function draftBackupExceedsImportLimits(backup, json = draftBackupJson(backup)) {
  const bytes = value => new TextEncoder().encode(value).length
  return bytes(json) > 3 * 1024 * 1024 || bytes(JSON.stringify(backup.content)) > 2 * 1024 * 1024 ||
    backup.content.ops.length > 10000
}

export function draftBackupText(backup) {
  return backup.content.ops.map(op => typeof op.insert === 'string' ? op.insert
    : op.insert?.image ? `[图片：${op.insert.image}]` : '').join('')
}
