import assert from 'node:assert/strict'
import test from 'node:test'
import Delta from 'quill-delta'
import CollabClient from './CollabClient.js'

function harness(clientId) {
  const sent = []
  let document = new Delta().insert('\n')
  const client = new CollabClient({
    docId: 1,
    clientId,
    Delta,
    onSync: (content) => { document = content },
    onRemote: (operation) => { document = document.compose(operation) },
  })
  client.attachSocket({ send: (message) => { sent.push(message); return true } })
  client.receive({ type: 'sync', docId: 1, revision: 0, content: { ops: [{ insert: '\n' }] } })
  return {
    client,
    sent,
    get document() { return document },
    local(operation) {
      document = document.compose(operation)
      client.submit(operation)
    },
  }
}

test('pending 被确认后发送 buffer，且使用最新 revision', () => {
  const editor = harness('one')
  editor.local(new Delta().insert('A'))
  editor.local(new Delta().retain(1).insert('B'))

  assert.equal(editor.sent.length, 1)
  assert.equal(editor.sent[0].baseRevision, 0)
  editor.client.receive({ type: 'ack', docId: 1, clientId: 'one', revision: 1 })
  assert.equal(editor.sent.length, 2)
  assert.equal(editor.sent[1].baseRevision, 1)
  assert.deepEqual(editor.sent[1].op.ops, [{ retain: 1 }, { insert: 'B' }])
  editor.client.receive({ type: 'ack', docId: 1, clientId: 'one', revision: 2 })
  assert.equal(editor.client.pending, null)
  editor.client.close()
})

test('两个客户端同位置并发插入最终收敛', () => {
  const a = harness('a')
  const b = harness('b')
  const opA = new Delta().insert('A')
  const opB = new Delta().insert('B')
  a.local(opA)
  b.local(opB)

  a.client.receive({ type: 'ack', docId: 1, clientId: 'a', revision: 1 })
  b.client.receive({ type: 'op', docId: 1, originClientId: 'a', revision: 1, op: opA })
  const bAfterA = opA.transform(opB, true)
  b.client.receive({ type: 'ack', docId: 1, clientId: 'b', revision: 2 })
  a.client.receive({ type: 'op', docId: 1, originClientId: 'b', revision: 2, op: bAfterA })

  assert.deepEqual(a.document.ops, [{ insert: 'AB\n' }])
  assert.deepEqual(b.document.ops, a.document.ops)
  a.client.close()
  b.client.close()
})

test('文档忙响应会重发未确认操作', async () => {
  const editor = harness('one')
  editor.local(new Delta().insert('A'))
  editor.client.receive({ type: 'error', code: 40901, message: '文档忙' })
  await new Promise((resolve) => setTimeout(resolve, 160))

  assert.equal(editor.sent.length, 2)
  assert.equal(editor.sent[1].baseRevision, 0)
  editor.client.close()
})
