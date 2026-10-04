const INVALID_LINK = '请输入有效网址，例如 https://example.com；也支持邮箱和电话链接'

export function normalizeDocumentLink(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(INVALID_LINK)
  const text = value.trim()
  if (!text) return ''
  if (text.length > 2048) throw new Error('链接地址最多2048个字符')
  const hostWithPort = /^(?:[^/?#:]+\.[^/?#:]+|localhost):\d+(?:[/?#]|$)/i.test(text)
  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(text) && !hostWithPort
  const candidate = text.startsWith('//') ? 'https:' + text : hasScheme ? text : 'https://' + text
  let url
  try { url = new URL(candidate) } catch { throw new Error(INVALID_LINK) }
  if (!['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) throw new Error(INVALID_LINK)
  if (url.protocol === 'mailto:' || url.protocol === 'tel:') {
    if (!url.pathname) throw new Error(INVALID_LINK)
  } else {
    const host = url.hostname
    if (!host || url.username || url.password) throw new Error(INVALID_LINK)
    if (!hasScheme && !host.includes('.') && host !== 'localhost' && !host.startsWith('[')) throw new Error(INVALID_LINK)
    if (!host.startsWith('[') && !host.replace(/\.$/, '').split('.').every(label =>
      /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))) throw new Error(INVALID_LINK)
  }
  if (url.href.length > 2048) throw new Error('链接地址最多2048个字符')
  return url.href
}

export function normalizePastedLinks(_node, delta) {
  delta.ops = delta.ops.map(op => {
    if (!op.attributes || !Object.hasOwn(op.attributes, 'link')) return op
    const attributes = { ...op.attributes }
    try { attributes.link = normalizeDocumentLink(attributes.link) } catch { delete attributes.link }
    if (!attributes.link) delete attributes.link
    const { attributes: _old, ...rest } = op
    return Object.keys(attributes).length ? { ...rest, attributes } : rest
  })
  return delta
}

export function transformLinkSelection(range, delta) {
  const index = delta.transformPosition(range.index, false)
  const end = delta.transformPosition(range.index + range.length, true)
  return { index, length: Math.max(0, end - index) }
}

export function configureLinkEditor(quill) {
  const tooltip = quill.theme.tooltip
  const input = tooltip.textbox
  let editingRange = null
  input.setAttribute('aria-label', '链接地址')
  input.maxLength = 2048
  input.setAttribute('data-link', 'https://example.com')
  const error = document.createElement('span')
  error.className = 'editor-link-error'
  error.setAttribute('role', 'alert')
  error.id = 'copage-link-error-' + (globalThis.crypto?.randomUUID?.() ?? Date.now())
  error.hidden = true
  input.setAttribute('aria-describedby', error.id)
  tooltip.root.appendChild(error)
  const reposition = () => {
    if (tooltip.root.classList.contains('ql-hidden')) return
    const bounds = quill.getBounds(editingRange ?? tooltip.linkRange ?? quill.selection.savedRange)
    if (bounds) tooltip.position(bounds)
  }
  const clearError = () => { error.hidden = true; error.textContent = ''; input.removeAttribute('aria-invalid') }
  input.addEventListener('input', clearError)
  const save = tooltip.save.bind(tooltip)
  const edit = tooltip.edit.bind(tooltip)
  const show = tooltip.show.bind(tooltip)
  const cancel = tooltip.cancel.bind(tooltip)
  tooltip.show = () => { editingRange = null; clearError(); return show() }
  tooltip.cancel = () => { editingRange = null; clearError(); return cancel() }
  tooltip.edit = (...args) => {
    const range = tooltip.linkRange ?? quill.getSelection() ?? quill.selection.savedRange
    editingRange = range ? { index: range.index, length: range.length } : null
    clearError()
    return edit(...args)
  }
  tooltip.save = () => {
    if (tooltip.root.getAttribute('data-mode') === 'link') {
      try {
        if (!quill.isEnabled()) throw new Error('文档尚未就绪，暂时不能保存链接')
        if (!editingRange?.length) throw new Error('所选文字已被删除，请取消后重新选择链接文字')
        input.value = normalizeDocumentLink(input.value)
        tooltip.linkRange = { ...editingRange }
      } catch (invalid) {
        error.textContent = invalid.message
        error.hidden = false
        input.setAttribute('aria-invalid', 'true')
        input.focus()
        reposition()
        return
      }
    }
    clearError()
    editingRange = null
    return save()
  }
  const action = tooltip.root.querySelector('.ql-action')
  const remove = tooltip.root.querySelector('.ql-remove')
  for (const button of [action, remove]) {
    button.setAttribute('role', 'button')
    button.tabIndex = 0
    button.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); button.click() }
    })
  }
  remove.setAttribute('aria-label', '移除链接')
  const updateAction = () => action.setAttribute('aria-label', tooltip.root.classList.contains('ql-editing') ? '保存链接' : '编辑链接')
  const observer = new MutationObserver(updateAction)
  observer.observe(tooltip.root, { attributes: true, attributeFilter: ['class'] })
  updateAction()
  window.addEventListener('resize', reposition)
  return {
    transform(delta) {
      if (editingRange) editingRange = transformLinkSelection(editingRange, delta)
      if (tooltip.linkRange) tooltip.linkRange = transformLinkSelection(tooltip.linkRange, delta)
      reposition()
    },
    dispose() { observer.disconnect(); input.removeEventListener('input', clearError); window.removeEventListener('resize', reposition) },
  }
}
