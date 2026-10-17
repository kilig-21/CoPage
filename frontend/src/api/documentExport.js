const invalidExport = () => new Error('导出回复不完整或格式不符，未生成副本。请重试，原文档仍保留。')

// 下载保留服务端的原始正文，不套用导入的片段、容量或格式归一化规则。
export function parseDocumentExport(value, format) {
  const mediaType = format === 'copage' ? 'application/json;charset=utf-8'
    : format === 'txt' ? 'text/plain;charset=utf-8' : null
  if (!mediaType || !value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.content !== 'string' || typeof value.filename !== 'string' || !value.filename.trim() ||
      value.mediaType !== mediaType || !Number.isSafeInteger(value.revision) || value.revision < 0) throw invalidExport()
  if (format === 'copage') {
    let copy
    try { copy = JSON.parse(value.content) } catch { throw invalidExport() }
    if (!copy || copy.format !== 'copage' || copy.version !== 1) throw invalidExport()
  }
  return { filename: value.filename, mediaType: value.mediaType, content: value.content, revision: value.revision }
}
