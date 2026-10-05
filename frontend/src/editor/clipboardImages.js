import { IMAGE_PLACEHOLDER } from './imageUpload.js'
import { normalizeDocumentLink } from './links.js'

const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const OMITTED_IMAGE = '[图片无法粘贴，请使用上传图片]'

// 服务端单次Delta最多10000片段，WS文本上限8 MiB；为协议字段留出空间。
export function clipboardPasteError(operation) {
  if (operation.ops.length > 10000) return '粘贴格式过于复杂，请分段粘贴；原选区已保留'
  if (new TextEncoder().encode(JSON.stringify(operation)).byteLength > 8 * 1024 * 1024 - 4096) {
    return '本次粘贴内容过大，请分段粘贴；原选区已保留'
  }
  return null
}

export function normalizeClipboardContent(delta) {
  const result = new delta.constructor()
  let changed = false
  for (const op of delta.ops) {
    const insert = typeof op.insert === 'string' ? op.insert.replace(/\u0000/g, '') : op.insert
    const attributes = { ...op.attributes }
    if (insert !== op.insert) changed = true
    for (const key of ['color', 'background']) {
      if (Object.hasOwn(attributes, key) && (typeof attributes[key] !== 'string' || !/^(?:#[a-fA-F0-9]{3,8}|[a-zA-Z]{1,20}|rgba?\([0-9., %]{1,40}\))$/.test(attributes[key]))) {
        delete attributes[key]
        changed = true
      }
    }
    if (insert !== '') result.insert(insert, attributes)
  }
  return { delta: result, changed }
}

export function normalizeImageAttributes(attributes = {}) {
  const result = { ...attributes }
  for (const key of ['width', 'height']) {
    if (Object.hasOwn(result, key) && (typeof result[key] !== 'string' || !/^(?:[1-9][0-9]{0,3}|10000|(?:[1-9][0-9]?|100)%)$/.test(result[key]))) delete result[key]
  }
  if (Object.hasOwn(result, 'alt')) result.alt = String(result.alt).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 512)
  return result
}

export function normalizeImageUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('无效图片地址')
  const url = new URL(value.startsWith('//') ? 'https:' + value : value)
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.href.length > 2048) throw new Error('无效图片地址')
  return normalizeDocumentLink(url.href)
}

export function embeddedImageFile(value, index) {
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([a-z\d+/=\s]+)$/i.exec(value)
  if (!match || match[2].length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 1024) throw new Error('不支持的内嵌图片')
  const bytes = Uint8Array.from(atob(match[2]), char => char.charCodeAt(0))
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('内嵌图片大小无效')
  const type = match[1].toLowerCase()
  return new File([bytes], `pasted-${index}.${type.slice(6)}`, { type })
}

// Clipboard 转换同步完成；含内嵌图片的整段内容只在上传全部成功后插入。
export function configureClipboardImages(quill, uploadFiles, notify) {
  const Delta = quill.constructor.import('delta')
  let conversion = null
  quill.clipboard.addMatcher('IMG', (node, delta) => {
    const attributes = normalizeImageAttributes(delta.ops.find(op => op.insert?.image)?.attributes)
    const source = node.getAttribute('src') ?? ''
    try {
      let url
      if (/^data:/i.test(source) && conversion) {
        if (conversion.files.length >= 10) throw new Error('一次最多上传10张图片，请分批粘贴')
        const file = embeddedImageFile(source, conversion.files.length)
        url = IMAGE_PLACEHOLDER + conversion.files.length
        conversion.files.push(file)
      } else {
        url = normalizeImageUrl(source)
      }
      return new Delta().insert({ image: url }, attributes)
    } catch {
      if (conversion) conversion.omitted = true
      return new Delta().insert(OMITTED_IMAGE)
    }
  })
  quill.clipboard.onPaste = (range, { text, html }) => {
    const context = { files: [], omitted: false }
    conversion = context
    let pasted
    try { pasted = quill.clipboard.convert({ text, html }, quill.getFormat(range.index)) }
    finally { conversion = null }
    const normalized = normalizeClipboardContent(pasted)
    pasted = normalized.delta
    const notice = [
      context.omitted ? '部分图片地址不可共享或格式不支持，已保留文字占位，请另行上传图片' : '',
      normalized.changed ? '已移除不支持的颜色格式或空字符，文字与其他格式保留' : '',
    ].filter(Boolean).join('；')
    if (!pasted.length()) {
      if (notice) notify(notice)
      return
    }
    const operation = new Delta().retain(range.index).delete(range.length).concat(pasted)
    const failure = clipboardPasteError(operation)
    if (failure) { notify(failure); return }
    if (context.files.length) {
      void uploadFiles(range, context.files, operation, notice)
    } else {
      quill.updateContents(operation, 'user')
      quill.setSelection(range.index + pasted.length(), 0, 'silent')
      quill.scrollSelectionIntoView()
      if (notice) notify(notice)
    }
  }
}
