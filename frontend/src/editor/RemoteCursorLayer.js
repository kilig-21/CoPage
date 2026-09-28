/** Quill 编辑区内的远端光标覆盖层；不修改正文，也不参与 OT 版本。 */
export default class RemoteCursorLayer {
  constructor(quill) {
    this.quill = quill
    this.cursors = new Map()
    this.element = document.createElement('div')
    this.element.className = 'remote-cursor-layer'
    this.element.setAttribute('aria-hidden', 'true')
    quill.container.appendChild(this.element)
  }

  update(cursor) {
    if (!cursor.visible) {
      this.remove(cursor.clientId)
      return
    }
    let entry = this.cursors.get(cursor.clientId)
    if (!entry) {
      const node = document.createElement('div')
      node.className = 'remote-cursor'
      const label = document.createElement('span')
      label.className = 'remote-cursor-label'
      node.appendChild(label)
      this.element.appendChild(node)
      entry = { node, label }
      this.cursors.set(cursor.clientId, entry)
    }
    entry.index = cursor.index
    entry.seenAt = Date.now()
    entry.node.style.setProperty('--remote-cursor-color', cursor.color)
    entry.label.textContent = cursor.nickname
    this.renderOne(entry)
  }

  transform(delta) {
    for (const entry of this.cursors.values()) {
      entry.index = delta.transformPosition(entry.index, true)
    }
    this.render()
  }

  render() {
    for (const entry of this.cursors.values()) this.renderOne(entry)
  }

  renderOne(entry) {
    try {
      const index = Math.min(entry.index, Math.max(0, this.quill.getLength() - 1))
      const bounds = this.quill.getBounds(index)
      entry.node.style.display = ''
      entry.node.style.transform = `translate(${bounds.left}px, ${bounds.top}px)`
      entry.node.style.height = `${Math.max(16, bounds.height || 0)}px`
    } catch {
      entry.node.style.display = 'none'
    }
  }

  expire(now = Date.now()) {
    for (const [clientId, entry] of this.cursors) {
      if (now - entry.seenAt > 60_000) this.remove(clientId)
    }
  }

  remove(clientId) {
    this.cursors.get(clientId)?.node.remove()
    this.cursors.delete(clientId)
  }

  clear() {
    for (const clientId of this.cursors.keys()) this.remove(clientId)
  }

  destroy() {
    this.clear()
    this.element.remove()
  }
}
