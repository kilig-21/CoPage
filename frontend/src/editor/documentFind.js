import { clipboardPasteError } from './clipboardImages.js'

export const EMPTY_DOCUMENT_FIND = { query: '', caseSensitive: false, count: 0, current: 0, canReplace: false, notice: '' }

export function findDocumentMatches(content, query, caseSensitive = false) {
  if (!query || query.includes('\0')) return new Uint32Array()
  const literal = query.replace(/[\\^$*+?.()|[\]{}]/g, '\\$&')
  const pattern = new RegExp(literal, caseSensitive ? 'gu' : 'giu')
  const result = []
  let text = '', position = 0, start = 0
  const flush = () => {
    for (const match of text.matchAll(pattern)) result.push(start + match.index, match[0].length)
    text = ''
  }
  for (const op of content.ops) {
    if (typeof op.insert === 'string') {
      if (!text) start = position
      text += op.insert
      position += op.insert.length
    } else {
      flush()
      position++
    }
  }
  // 正文末尾换行属于文档结构，查找/替换不选中它。
  if (text.endsWith('\n')) text = text.slice(0, -1)
  flush()
  return Uint32Array.from(result)
}

export function documentReplacement(content, matches, replacement, Delta) {
  if (replacement.includes('\0')) throw new Error('替换文字包含不支持的空字符')
  const source = content.ops.map(op => typeof op.insert === 'string' ? op.insert : '\ufffc').join('')
  const images = []
  let offset = 0
  for (const op of content.ops) {
    if (typeof op.insert !== 'string') images.push(offset)
    offset += typeof op.insert === 'string' ? op.insert.length : 1
  }
  // 先算最终文字大小的下界，避免大量匹配把一个短输入扩成巨型字符串。
  // 图片的占位仅用于索引，其实际JSON开销更大；完整容量仍由原守卫检查。
  const encoder = new TextEncoder(), sizes = new Map()
  const size = value => {
    if (!sizes.has(value)) sizes.set(value, encoder.encode(value).length)
    return sizes.get(value)
  }
  let checkedEnd = 0, checkedImage = 0, removedBytes = 0, changedTotal = 0
  for (let i = 0; i < matches.length; i += 2) {
    const index = matches[i], length = matches[i + 1], end = index + length
    while (checkedImage < images.length && images[checkedImage] < index) checkedImage++
    if (!Number.isSafeInteger(index) || !Number.isSafeInteger(length) || length <= 0 ||
        index < checkedEnd || end > source.length - 1 || (images[checkedImage] ?? Infinity) < end) {
      throw new Error('匹配范围已经变化，请重新查找')
    }
    checkedEnd = end
    const original = source.slice(index, end)
    if (original !== replacement) { removedBytes += size(original); changedTotal++ }
  }
  if (size(source) - removedBytes + size(replacement) * changedTotal > 2 * 1024 * 1024) {
    throw new Error('替换后正文会超过 2 MiB，请缩小范围或替换文字；正文未修改')
  }
  const block = new Set(['header', 'list', 'indent', 'align', 'direction', 'blockquote', 'code-block'])
  let opIndex = 0, opStart = 0, cursor = 0, changed = 0
  const operation = new Delta()
  for (let i = 0; i < matches.length; i += 2) {
    const index = matches[i], length = matches[i + 1], end = index + length
    if (source.slice(index, end) === replacement) continue
    while (opIndex < content.ops.length) {
      const op = content.ops[opIndex]
      const size = typeof op.insert === 'string' ? op.insert.length : 1
      if (opStart + size > index) break
      opStart += size
      opIndex++
    }
    const attributes = Object.fromEntries(Object.entries(content.ops[opIndex]?.attributes ?? {})
      .filter(([key]) => !block.has(key)))
    operation.retain(index - cursor).insert(replacement, attributes).delete(length)
    if (operation.ops.length > 10000) throw new Error('替换内容过于复杂，请缩小查找范围后重试；正文未修改')
    cursor = end
    changed++
  }
  return { operation: operation.chop(), changed }
}

export function createDocumentFind(quill, { Delta, canReplace, onState }) {
  let query = '', caseSensitive = false, matches = new Uint32Array(), current = -1, notice = '', lastState = null, opened = false, selectionSuspended = false
  const publish = () => {
    const next = { query, caseSensitive, count: matches.length / 2, current: current + 1, canReplace: opened && canReplace() && !selectionSuspended, notice }
    if (!lastState || Object.keys(next).some(key => next[key] !== lastState[key])) {
      lastState = next
      onState(next)
    }
  }
  const recompute = anchor => {
    matches = findDocumentMatches(quill.getContents(), query, caseSensitive)
    const count = matches.length / 2
    let left = 0, right = count
    while (left < right) {
      const middle = Math.floor((left + right) / 2)
      if (matches[middle * 2] < anchor) left = middle + 1
      else right = middle
    }
    current = count ? (left < count ? left : 0) : -1
  }
  const highlightName = 'copage-document-find-current'
  const clearHighlight = () => quill.root.ownerDocument.defaultView?.CSS?.highlights?.delete(highlightName)
  const paint = () => {
    const document = quill.root.ownerDocument, view = document.defaultView
    if (current < 0) { clearHighlight(); return null }
    if (!view?.CSS?.highlights || !view.Highlight || !quill.getLeaf) return null
    const range = document.createRange()
    const boundary = (index, first) => {
      const [leaf, offset] = quill.getLeaf(index)
      if (!leaf?.domNode) return false
      const node = leaf.domNode
      if (node.nodeType === 3) {
        range[first ? 'setStart' : 'setEnd'](node, Math.min(offset, node.data.length))
      } else {
        range[first ? (offset ? 'setStartAfter' : 'setStartBefore') : (offset ? 'setEndAfter' : 'setEndBefore')](node)
      }
      return true
    }
    if (!boundary(matches[current * 2], true) || !boundary(matches[current * 2] + matches[current * 2 + 1], false)) {
      clearHighlight()
      return null
    }
    view.CSS.highlights.set(highlightName, new view.Highlight(range))
    return range
  }
  const select = () => {
    if (current < 0) { clearHighlight(); return }
    if (selectionSuspended) return
    const document = quill.root.ownerDocument, focus = document.activeElement
    const highlight = paint()
    let range = highlight
    if (highlight) {
      // 独立高亮不使用输入框/正文的原生选区，不打断用户输入。
      const selection = document.getSelection()
      if (selection?.rangeCount && quill.root.contains(selection.getRangeAt(0).startContainer)) selection.removeAllRanges()
      quill.scrollRectIntoView(highlight.getBoundingClientRect())
    } else {
      quill.setSelection(matches[current * 2], matches[current * 2 + 1], 'silent')
      quill.scrollSelectionIntoView()
      const selection = document.getSelection()
      range = selection?.rangeCount ? selection.getRangeAt(0) : null
    }
    const panel = document.querySelector('[data-document-find-panel]')
    if (panel && range) {
      const rect = range.getBoundingClientRect(), panelRect = panel.getBoundingClientRect()
      if (rect.top < panelRect.bottom + 8) document.defaultView.scrollBy(0, rect.top - panelRect.bottom - 8)
    }
    if (focus && focus !== quill.root && focus !== document.body && focus.isConnected) focus.focus({ preventScroll: true })
  }
  const setQuery = (value, sensitive = caseSensitive, selectMatches = true) => {
    selectionSuspended = !selectMatches
    query = value
    caseSensitive = sensitive
    notice = value.includes('\0') ? '查找文字包含不支持的空字符' : ''
    recompute(0)
    select()
    publish()
  }
  publish()
  return {
    setQuery,
    start() {
      opened = true
      recompute(current >= 0 ? matches[current * 2] : 0)
      const selection = quill.getSelection()
      if (selection?.length && selection.length <= 200) {
        const text = quill.getText(selection.index, selection.length)
        if (text && !text.includes('\n') && text !== query) setQuery(text)
      }
      select()
      publish()
    },
    pause() {
      if (current >= 0 && !selectionSuspended) quill.setSelection(matches[current * 2], matches[current * 2 + 1], 'silent')
      clearHighlight()
      opened = false; selectionSuspended = false; matches = new Uint32Array(); current = -1; notice = ''
      publish()
    },
    dispose: clearHighlight,
    next(step = 1) {
      const count = matches.length / 2
      if (count) { current = (current + step + count) % count; select() }
      publish()
    },
    changed(delta) {
      if (!opened) { publish(); return }
      const anchor = current >= 0 ? delta.transformPosition(matches[current * 2], true) : 0
      recompute(anchor)
      if (!selectionSuspended) paint()
      publish()
    },
    refreshSelection: select,
    refreshStatus: publish,
    replace(replacement, all = false) {
      if (!opened || !canReplace() || selectionSuspended) { notice = '当前不能替换，请确认编辑权限并等待同步或输入完成'; publish(); return }
      try {
        const anchor = current >= 0 ? matches[current * 2] : 0
        recompute(anchor)
        if (current < 0) { notice = '没有匹配的文字'; publish(); return }
        const selected = all ? matches : matches.slice(current * 2, current * 2 + 2)
        const { operation, changed } = documentReplacement(quill.getContents(), selected, replacement, Delta)
        const failure = clipboardPasteError(operation, quill.getContents())
        if (failure) throw new Error(failure.replaceAll('粘贴', '替换').replace('；原选区已保留', '；正文未修改'))
        if (!changed) { notice = '替换文字与原文相同，正文未修改'; publish(); return }
        const history = quill.getModule('history')
        history.cutoff()
        quill.updateContents(operation, 'user')
        history.cutoff()
        recompute(all ? 0 : anchor + replacement.length)
        notice = '已修改 ' + changed + ' 处，请查看保存状态确认同步'
        select()
        publish()
      } catch (error) { notice = error.message || '替换未完成，请检查正文和保存状态后重试'; publish() }
    },
  }
}
