import { isDocumentSnapshotContent } from './documentSnapshotContent.js'

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const documentId = value => Number.isSafeInteger(value) && value > 0
const invalidSnapshot = () => new Error('打印预览回复不完整或格式不符，尚未生成打印副本。请刷新预览，原文档仍保留。')

// 打印读取的是存量全文；只核对结构，不套用导入的容量/片段限制或改写正文。
export function parsePrintSnapshot(reply, expectedId) {
  const value = reply?.data
  if (!record(reply) || reply.code !== 0 || !documentId(expectedId) || !record(value) ||
      value.id !== expectedId || typeof value.title !== 'string' || !value.title.trim() ||
      !Number.isSafeInteger(value.revision) || value.revision < 0 || !isDocumentSnapshotContent(value.content)) throw invalidSnapshot()
  return value
}

export function confirmPrintAccess(reply, expectedId) {
  if (!record(reply) || reply.code !== 0 || !documentId(expectedId) ||
      !record(reply.data) || reply.data.id !== expectedId) {
    throw new Error('打印权限回复无法确认，尚未打开打印窗口。请重试，原文档仍保留。')
  }
}
