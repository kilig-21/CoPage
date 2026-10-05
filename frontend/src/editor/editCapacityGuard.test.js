import assert from 'node:assert/strict'
import test from 'node:test'
import Delta from 'quill-delta'
import CollabClient from '../ws/CollabClient.js'
import { createEditCapacityGuard } from './editCapacityGuard.js'

function harness(content) {
  const notices = []
  let guard
  let selection = { index: 1, length: 0 }
  const client = new CollabClient({ docId: 1, clientId: 'limits', Delta })
  client.state = 'ready'
  client.attachSocket({ send: () => true })
  const history = {
    stack: { undo: [{ delta: new Delta().delete(1) }], redo: [{ delta: new Delta().insert('old') }] },
    lastRecorded: 10, currentRange: { index: 1, length: 0 }, ignoreChange: false,
    record() { this.stack.undo.push({ delta: new Delta().insert('new') }); this.stack.redo = []; this.lastRecorded = 20 },
    change() {
      this.stack.undo.pop()
      this.stack.redo.push({ delta: new Delta().insert('would redo') })
      this.ignoreChange = true
      quill.updateContents(new Delta().insert('中'), 'user')
      this.ignoreChange = false
      quill.setSelection({ index: 0, length: 0 })
    },
  }
  const quill = {
    getModule: () => history, getSelection: () => selection,
    setSelection: range => { selection = range },
    updateContents(delta, source) {
      const old = content
      content = old.compose(delta)
      if (source === 'user' && !history.ignoreChange) history.record(delta, old)
      if (guard.accept(delta, old, source) && source === 'user') client.submit(delta)
    },
  }
  guard = createEditCapacityGuard(quill, notice => notices.push(notice))
  return { quill, history, guard, client, notices, get content() { return content }, get selection() { return selection } }
}

function fullContent() {
  const size = new TextEncoder().encode(JSON.stringify(new Delta().insert('\n'))).length
  return new Delta().insert('x'.repeat(2 * 1024 * 1024 - size) + '\n')
}

test('超限键入退回正文及历史记录，不影响先前pending/buffer或产生新提交', () => {
  const editor = harness(fullContent())
  const before = editor.content
  const undo = [...editor.history.stack.undo]
  const redo = [...editor.history.stack.redo]
  editor.client.submit(new Delta().insert('pending'))
  editor.client.submit(new Delta().insert('buffer'))
  const pending = editor.client.pending
  const buffer = editor.client.buffer
  editor.quill.updateContents(new Delta().insert('中'), 'user')
  assert.deepEqual(editor.content, before)
  assert.deepEqual(editor.history.stack.undo, undo)
  assert.deepEqual(editor.history.stack.redo, redo)
  assert.equal(editor.history.lastRecorded, 10)
  assert.equal(editor.history.ignoreChange, false)
  assert.equal(editor.client.pending, pending)
  assert.equal(editor.client.buffer, buffer)
  assert.match(editor.notices[0], /修改后正文会超过 2 MiB/)
  editor.client.close()
})

test('撤销导致容量超限时保留原撤销/重做栈及光标，随后缩减内容仍可提交', () => {
  const editor = harness(fullContent())
  const before = editor.content
  const undo = [...editor.history.stack.undo]
  const redo = [...editor.history.stack.redo]
  editor.history.change('undo', 'redo')
  assert.deepEqual(editor.content, before)
  assert.deepEqual(editor.history.stack.undo, undo)
  assert.deepEqual(editor.history.stack.redo, redo)
  assert.deepEqual(editor.selection, { index: 1, length: 0 })
  assert.equal(editor.client.hasUnconfirmedChanges(), false)
  editor.quill.updateContents(new Delta().delete(100), 'user')
  assert.equal(editor.content.length(), before.length() - 100)
  assert.ok(editor.client.hasUnconfirmedChanges())
  editor.client.close()
})

test('远端编辑不被本地容量拦截；卸载还原Quill历史方法', () => {
  const editor = harness(new Delta().insert('正文\n'))
  editor.quill.updateContents(new Delta().insert('远端'), 'api')
  assert.equal(editor.content.ops[0].insert, '远端正文\n')
  assert.equal(editor.notices.length, 0)
  assert.equal(editor.client.hasUnconfirmedChanges(), false)
  const wrapped = editor.history.record
  editor.guard.dispose()
  assert.notEqual(editor.history.record, wrapped)
  editor.client.close()
})
