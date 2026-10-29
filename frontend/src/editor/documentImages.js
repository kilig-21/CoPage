import { clipboardPasteError } from './clipboardImages.js'

export const EMPTY_DOCUMENT_IMAGES = { images: [], canEdit: false }

export function documentImages(content) {
  const images = []
  let index = 0
  for (const op of content.ops) {
    if (typeof op.insert?.image === 'string') images.push({ index, src: op.insert.image, alt: op.attributes?.alt ?? '' })
    index += typeof op.insert === 'string' ? op.insert.length : 1
  }
  return images
}

// 图片身份只在本次打开期间存在，不写入正文。范围两端分别变换，删除后
// 即使相同位置插入相同 URL，也不能把旧表单当成新图片的编辑授权。
export function createDocumentImages(quill, { Delta, canEdit, onState }) {
  let opened = false, disposed = false, records = [], sequence = 0
  const publish = () => {
    if (opened && !disposed) onState({ images: records.map(record => ({ ...record })), canEdit: canEdit() })
  }
  const refresh = delta => {
    const previous = records.map(record => {
      if (!delta) return record
      const index = delta.transformPosition(record.index, false)
      const end = delta.transformPosition(record.index + 1, true)
      return end - index === 1 ? { ...record, index } : null
    }).filter(Boolean)
    const byIndex = new Map(previous.map(record => [record.index, record]))
    records = documentImages(quill.getContents()).map(image => {
      const old = byIndex.get(image.index)
      return { ...image, id: old?.src === image.src ? old.id : String(++sequence) }
    })
  }
  return {
    start() { if (disposed) return; opened = true; records = []; refresh(); publish() },
    pause() { opened = false; records = [] },
    changed(delta) { if (opened && !disposed) { refresh(delta); publish() } },
    refreshStatus: publish,
    save(id, description, expectedAlt) {
      if (!opened || disposed || !canEdit()) throw new Error('请先恢复编辑权限，并等待连接、输入和保存完成；填写的说明仍保留')
      if (typeof description !== 'string' || description.length > 512 || /[\u0000-\u001f\u007f]/.test(description)) {
        throw new Error('图片说明最多512个字符，请使用不含换行或控制字符的一段文字')
      }
      const target = records.find(record => record.id === id)
      const current = target && documentImages(quill.getContents()).find(image => image.index === target.index && image.src === target.src)
      if (!current) throw new Error('这张图片已被移除或替换，请重新选择；填写的说明仍保留')
      if (current.alt !== expectedAlt) throw new Error('图片说明已被修改，请重新选择图片核对最新说明；填写的文字仍保留')
      if (current.alt === description) return { changed: false, description }
      const operation = new Delta().retain(current.index).retain(1, { alt: description || null })
      const failure = clipboardPasteError(operation, quill.getContents())
      if (failure) throw new Error(failure.replaceAll('粘贴', '修改').replace('；原选区已保留', '；正文和填写的说明保留'))
      quill.getModule('history').cutoff()
      quill.updateContents(operation, 'user')
      quill.getModule('history').cutoff()
      return { changed: true, description }
    },
    dispose() { disposed = true; records = [] },
  }
}
