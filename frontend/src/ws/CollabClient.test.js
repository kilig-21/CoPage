import assert from 'node:assert/strict'
import test from 'node:test'
import Delta from 'quill-delta'
import CollabClient from './CollabClient.js'

function harness(clientId) {
  const sent = []
  const errors = []
  let document = new Delta().insert('\n')
  const client = new CollabClient({
    docId: 1,
    clientId,
    Delta,
    onSync: (content) => { if (content) document = content },
    onRemote: (operation) => { document = document.compose(operation) },
    onError: (message) => errors.push(message),
  })
  client.attachSocket({ send: (message) => { sent.push(message); return true } })
  client.join()
  client.receive({ type: 'sync', docId: 1, syncId: client.syncId, fromRevision: 0,
    revision: 0, historyComplete: true, history: [], pendingCommittedRevision: null,
    content: { ops: [{ insert: '\n' }] } })
  sent.length = 0
  return {
    client,
    sent,
    errors,
    get document() { return document },
    local(operation) {
      document = document.compose(operation)
      client.submit(operation)
    },
    ack(revision, opId = client.pending?.opId) {
      client.receive({ type: 'ack', docId: 1, clientId, revision, opId })
    },
    reconnect({ revision, content, history = [], pendingCommittedRevision = null, historyComplete = true }) {
      client.disconnect()
      client.join()
      client.receive({ type: 'sync', docId: 1, syncId: client.syncId, fromRevision: client.revision,
        revision, content, history, pendingCommittedRevision, historyComplete })
    },
  }
}

test('pending 被确认后发送 buffer，且使用最新 revision', () => {
  const editor = harness('one')
  editor.local(new Delta().insert('A'))
  editor.local(new Delta().retain(1).insert('B'))

  assert.equal(editor.sent.length, 1)
  assert.equal(editor.sent[0].baseRevision, 0)
  editor.ack(1)
  assert.equal(editor.sent.length, 2)
  assert.equal(editor.sent[1].baseRevision, 1)
  assert.deepEqual(editor.sent[1].op.ops, [{ retain: 1 }, { insert: 'B' }])
  editor.ack(2)
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

  a.ack(1)
  b.client.receive({ type: 'op', docId: 1, originClientId: 'a', revision: 1, op: opA })
  const bAfterA = opA.transform(opB, true)
  b.ack(2)
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

test('确认丢失后追赶远端历史，保留 buffer 且不重复提交已落库操作', () => {
  const editor = harness('one')
  editor.local(new Delta().insert('A'))
  const oldOpId = editor.client.pending.opId
  editor.local(new Delta().retain(1).insert('B'))
  editor.reconnect({ revision: 3, content: new Delta().insert('XAY\n'), pendingCommittedRevision: 2,
    history: [
      { revision: 1, op: new Delta().insert('X') },
      { revision: 2, op: new Delta().retain(1).insert('A') },
      { revision: 3, op: new Delta().retain(2).insert('Y') },
    ] })

  assert.deepEqual(editor.document.ops, [{ insert: 'XAYB\n' }])
  assert.equal(editor.client.state, 'ready')
  const outgoing = editor.sent.filter(message => message.type === 'op')
  assert.equal(outgoing.length, 2)
  assert.notEqual(outgoing[1].opId, oldOpId)
  assert.equal(outgoing[1].baseRevision, 3)
  assert.deepEqual(outgoing[1].op.ops, [{ retain: 3 }, { insert: 'B' }])
  editor.ack(4)
  assert.equal(editor.client.hasUnconfirmedChanges(), false)
  editor.client.close()
})

test('操作尚未提交时保留原请求重发，同时变换本地 pending 和 buffer', () => {
  const editor = harness('one')
  editor.local(new Delta().insert('A'))
  editor.local(new Delta().retain(1).insert('B'))
  const original = editor.sent[0]
  editor.reconnect({ revision: 1, content: new Delta().insert('X\n'),
    history: [{ revision: 1, op: new Delta().insert('X') }] })

  assert.deepEqual(editor.document.ops, [{ insert: 'XAB\n' }])
  const retried = editor.sent.at(-1)
  assert.equal(retried.opId, original.opId)
  assert.equal(retried.baseRevision, 0)
  assert.deepEqual(retried.op.ops, [{ insert: 'A' }])
  assert.deepEqual(editor.client.pending.delta.ops, [{ retain: 1 }, { insert: 'A' }])
  editor.ack(2)
  assert.equal(editor.sent.at(-1).baseRevision, 2)
  assert.deepEqual(editor.sent.at(-1).op.ops, [{ retain: 2 }, { insert: 'B' }])
  editor.client.close()
})

test('旧操作的重复 ack 不会清除下一条 pending', () => {
  const editor = harness('one')
  editor.local(new Delta().insert('A'))
  const oldId = editor.client.pending.opId
  editor.local(new Delta().retain(1).insert('B'))
  editor.ack(1)
  const newId = editor.client.pending.opId
  editor.ack(1, oldId)
  assert.equal(editor.client.pending.opId, newId)
  assert.equal(editor.client.revision, 1)
  editor.client.close()
})

test('新连接收到旧连接提交的同 opId 广播时只确认，不二次应用', () => {
  const editor = harness('one')
  editor.local(new Delta().insert('A'))
  const opId = editor.client.pending.opId
  editor.reconnect({ revision: 0, content: new Delta().insert('\n') })
  editor.client.receive({ type: 'op', docId: 1, originClientId: 'one', opId,
    revision: 1, op: new Delta().insert('A') })
  assert.deepEqual(editor.document.ops, [{ insert: 'A\n' }])
  assert.equal(editor.client.pending, null)
  assert.equal(editor.client.revision, 1)
  editor.client.close()
})

test('跳号确认触发追赶并保留未确认编辑', () => {
  const editor = harness('one')
  editor.local(new Delta().insert('A'))
  editor.ack(2)
  assert.equal(editor.client.state, 'syncing')
  assert.equal(editor.client.revision, 0)
  assert.ok(editor.client.pending)
  assert.deepEqual(editor.document.ops, [{ insert: 'A\n' }])
  assert.equal(editor.sent.at(-1).type, 'join')
  assert.equal(editor.sent.at(-1).pendingOpId, editor.client.pending.opId)
  editor.client.close()
})

test('历史缺口时停止恢复但保留正文和全部未确认编辑', () => {
  const editor = harness('one')
  editor.local(new Delta().insert('A'))
  editor.local(new Delta().retain(1).insert('B'))
  const pendingId = editor.client.pending.opId
  editor.reconnect({ revision: 2001, content: new Delta().insert('server\n'), historyComplete: false })
  assert.equal(editor.client.state, 'blocked')
  assert.equal(editor.client.pending.opId, pendingId)
  assert.ok(editor.client.buffer)
  assert.deepEqual(editor.document.ops, [{ insert: 'AB\n' }])
  assert.equal(editor.sent.filter(message => message.type === 'op').length, 1)
  editor.client.close()
})

test('消息跳号和延迟重复 op 不会直接推进版本或重复应用', () => {
  const editor = harness('one')
  const first = { type: 'op', docId: 1, originClientId: 'other', revision: 1, op: new Delta().insert('X') }
  editor.client.receive(first)
  editor.client.receive(first)
  assert.deepEqual(editor.document.ops, [{ insert: 'X\n' }])
  editor.client.receive({ ...first, revision: 3, op: new Delta().insert('Z') })
  assert.equal(editor.client.state, 'syncing')
  assert.equal(editor.client.revision, 1)
  assert.deepEqual(editor.document.ops, [{ insert: 'X\n' }])
  editor.client.close()
})

test('心跳发现静默漏广播后重新同步，无未确认编辑时可加载快照', () => {
  const editor = harness('one')
  editor.client.receive({ type: 'pong', docId: 1, revision: 2 })
  const syncId = editor.client.syncId
  editor.client.receive({ type: 'sync', docId: 1, syncId: 'stale', revision: 99,
    content: new Delta().insert('wrong\n') })
  assert.equal(editor.client.revision, 0)
  editor.client.receive({ type: 'sync', docId: 1, syncId, revision: 2,
    historyComplete: false, content: new Delta().insert('XY\n') })
  assert.equal(editor.client.revision, 2)
  assert.deepEqual(editor.document.ops, [{ insert: 'XY\n' }])
  editor.client.close()
})

test('join 遇到锁忙也会重试，不能永远卡在同步中', async () => {
  const editor = harness('one')
  editor.client.join()
  const firstSyncId = editor.client.syncId
  editor.client.receive({ type: 'error', code: 40901, message: '文档忙' })
  await new Promise(resolve => setTimeout(resolve, 160))
  assert.notEqual(editor.client.syncId, firstSyncId)
  assert.equal(editor.sent.at(-1).type, 'join')
  editor.client.close()
})
