import assert from 'node:assert/strict'
import test from 'node:test'
import RemoteCursorLayer from './RemoteCursorLayer.js'

class FakeElement {
  constructor() {
    this.children = []
    this.style = { setProperty: (name, value) => { this.style[name] = value } }
  }
  appendChild(child) {
    this.children.push(child)
    child.parent = this
  }
  setAttribute(name, value) { this[name] = value }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this)
  }
}

test('远端光标用纯文本名字绘制，跟随 Delta 位移并可隐藏/过期', () => {
  const oldDocument = globalThis.document
  globalThis.document = { createElement: () => new FakeElement() }
  try {
    const container = new FakeElement()
    const quill = { container, getLength: () => 5,
      getBounds: (index) => ({ left: index * 10, top: 20, height: 18 }) }
    const layer = new RemoteCursorLayer(quill)
    layer.update({ clientId: 'peer', index: 1, visible: true,
      color: '#2563eb', nickname: '<img src=x onerror=alert(1)>' })
    const entry = layer.cursors.get('peer')
    assert.equal(entry.label.textContent, '<img src=x onerror=alert(1)>')
    assert.equal(entry.node.style.transform, 'translate(10px, 20px)')
    layer.transform({ transformPosition: (index) => index + 2 })
    assert.equal(entry.node.style.transform, 'translate(30px, 20px)')
    layer.expire(entry.seenAt + 60_001)
    assert.equal(layer.cursors.size, 0)
    layer.update({ clientId: 'peer', index: 1, visible: true, color: '#2563eb', nickname: '同学' })
    layer.update({ clientId: 'peer', visible: false })
    assert.equal(layer.cursors.size, 0)
    layer.destroy()
    assert.equal(container.children.length, 0)
  } finally {
    globalThis.document = oldDocument
  }
})
