import assert from 'node:assert/strict'
import test from 'node:test'
import Delta from 'quill-delta'
import CollabClient from './CollabClient.js'

test('超过2000条的分批历史保留pending和buffer，直到完整验证才更新编辑器', () => {
  const editor = harness('long-offline')
  editor.local(new Delta().insert('A'))
  editor.local(new Delta().retain(1).insert('B'))
  const originalId = editor.client.pending.opId
  editor.client.disconnect(); editor.client.join()
  const syncId = editor.client.syncId
  editor.client.receive({ type: 'sync', docId: 1, syncId, fromRevision: 0, revision: 3001,
    content: {ops:[{insert:'R'.repeat(3001)+'\n'}]}, historyComplete:false, historyPaged:true,
    pendingCommittedRevision:null })
  assert.equal(editor.sent.at(-1).type, 'history_request')
  for (let from = 0; from < 3001; from += 256) {
    const to = Math.min(3001, from + 256)
    editor.client.receive({type:'history_page', docId:1, syncId, fromRevision:from, toRevision:to, revision:3001,
      history:Array.from({length:to-from}, (_,i)=>({revision:from+i+1,op:{ops:[{insert:'R'}]}}))})
    if (to < 3001) {
      assert.equal(editor.client.revision, 0)
      assert.equal(editor.document.ops[0].insert, 'AB\n')
    }
  }
  assert.equal(editor.client.state, 'ready')
  assert.equal(editor.client.revision, 3001)
  assert.equal(editor.client.pending.opId, originalId)
  assert.equal(editor.document.ops[0].insert, 'R'.repeat(3001)+'AB\n')
  assert.equal(editor.sent.at(-1).baseRevision, 0)
  editor.client.close()
})

test('分批恢复跳过已提交pending；重复页不重复应用，缺口保留原草稿', () => {
  const editor = harness('lost-ack')
  editor.local(new Delta().insert('A'))
  editor.local(new Delta().retain(1).insert('B'))
  editor.client.disconnect(); editor.client.join()
  const syncId = editor.client.syncId
  editor.client.receive({type:'sync',docId:1,syncId,fromRevision:0,revision:3,historyComplete:false,historyPaged:true,pendingCommittedRevision:1})
  const first = {type:'history_page',docId:1,syncId,fromRevision:0,toRevision:1,revision:3,
    history:[{revision:1,op:{ops:[{insert:'A'}]}}]}
  editor.client.receive(first); editor.client.receive(first)
  assert.equal(editor.client.pagedRecovery.revision, 1)
  editor.client.receive({type:'history_page',docId:1,syncId,fromRevision:1,toRevision:3,revision:3,
    history:[{revision:2,op:{ops:[{insert:'R'}]}},{revision:3,op:{ops:[{insert:'S'}]}}]})
  assert.equal(editor.document.ops[0].insert, 'SRAB\n')
  assert.equal(editor.client.pending.baseRevision, 3)
  editor.client.close()
  const broken = harness('broken')
  broken.local(new Delta().insert('本地'))
  broken.client.disconnect(); broken.client.join()
  const id = broken.client.syncId
  broken.client.receive({type:'sync',docId:1,syncId:id,fromRevision:0,revision:3000,historyComplete:false,historyPaged:true})
  broken.client.receive({type:'history_page',docId:1,syncId:id,fromRevision:0,toRevision:2,revision:3000,
    history:[{revision:2,op:{ops:[{insert:'R'}]}}]})
  assert.equal(broken.client.state, 'blocked')
  assert.equal(broken.document.ops[0].insert, '本地\n')
  assert.ok(broken.client.exportDraft(broken.document))
})

function harness(clientId) {
  const sent = []
  const errors = []
  const cursors = []
  let document = new Delta().insert('\n')
  const client = new CollabClient({
    docId: 1,
    clientId,
    Delta,
    onSync: (content) => { if (content) document = content },
    onRemote: (operation) => { document = document.compose(operation) },
    onError: (message) => errors.push(message),
    onCursor: (cursor) => cursors.push(cursor),
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
    cursors,
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

test('撤销权限阻止后续内容应用；降为只读保留未确认正文与原请求', () => {
  const revoked = harness('revoked')
  revoked.client.receive({ type: 'permission', docId: 1, permission: 0 })
  revoked.client.receive({ type: 'op', docId: 1, revision: 1, op: { ops: [{ insert: '秘密' }] } })
  assert.equal(revoked.client.state, 'blocked')
  assert.deepEqual(revoked.document.ops, [{ insert: '\n' }])

  const pending = harness('pending')
  pending.local(new Delta().insert('本地'))
  const opId = pending.client.pending.opId
  pending.client.receive({ type: 'permission', docId: 1, permission: 1 })
  assert.equal(pending.client.state, 'blocked')
  assert.equal(pending.client.pending.opId, opId)
  assert.deepEqual(pending.document.ops, [{ insert: '本地\n' }])
  assert.ok(pending.client.exportDraft(pending.document))

  const reader = harness('reader')
  reader.client.receive({ type: 'permission', docId: 1, permission: 1 })
  reader.client.receive({ type: 'op', docId: 1, revision: 1, op: { ops: [{ insert: '可见' }] } })
  assert.equal(reader.client.state, 'ready')
  assert.deepEqual(reader.document.ops, [{ insert: '可见\n' }])
})

test('远端光标仅在同步就绪时转交绘制层，忽略自身与非法坐标', () => {
  const editor = harness('self')
  const valid = { type: 'cursor', docId: 1, clientId: 'peer', index: 2, length: 0,
    visible: true, nickname: '同学', color: '#2563eb' }
  editor.client.receive(valid)
  editor.client.receive({ ...valid, clientId: 'self' })
  editor.client.receive({ ...valid, index: -1 })
  editor.client.receive({ ...valid, visible: 'false' })
  editor.client.receive({ ...valid, color: 'red;display:none' })
  assert.deepEqual(editor.cursors, [{ clientId: 'peer', index: 2, length: 0,
    visible: true, nickname: '同学', color: '#2563eb' }])
  editor.client.disconnect()
  editor.client.receive({ ...valid, visible: false })
  assert.equal(editor.cursors.length, 1)
  editor.client.close()
})

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

test('刷新后草稿恢复沿用原 clientId/opId，未提交操作和 buffer 不丢失', () => {
  const before = harness('original-client')
  before.local(new Delta().insert('A'))
  before.local(new Delta().retain(1).insert('B'))
  const draft = before.client.exportDraft(before.document)
  assert.equal(draft.content.ops[0].insert, 'AB\n')
  before.client.close()

  let document = new Delta().insert('\n')
  const sent = []
  const restored = new CollabClient({
    docId: 1, clientId: 'new-page', Delta,
    onSync: (content) => { if (content) document = content },
    onRemote: (operation) => { document = document.compose(operation) },
  })
  restored.attachSocket({ send: (message) => { sent.push(message); return true } })
  document = restored.restoreDraft(draft)
  assert.equal(restored.clientId, 'original-client')
  restored.join()
  assert.equal(sent[0].pendingOpId, draft.pending.opId)
  assert.deepEqual(sent[0].pendingOp, draft.pending.original)
  restored.receive({ type: 'sync', docId: 1, syncId: restored.syncId,
    fromRevision: 0, revision: 0, historyComplete: true, history: [],
    pendingCommittedRevision: null, content: new Delta().insert('\n') })
  assert.equal(sent[1].opId, draft.pending.opId)
  assert.deepEqual(document.ops, [{ insert: 'AB\n' }])
  restored.receive({ type: 'ack', docId: 1, clientId: restored.clientId,
    opId: draft.pending.opId, revision: 1 })
  assert.equal(sent[2].baseRevision, 1)
  assert.deepEqual(sent[2].op.ops, [{ retain: 1 }, { insert: 'B' }])
  restored.close()
})

test('没有未确认编辑不导出草稿，损坏草稿不会改变客户端状态', () => {
  const editor = harness('one')
  assert.equal(editor.client.exportDraft(editor.document), null)
  assert.throws(() => editor.client.restoreDraft({ version: 1, docId: 1,
    clientId: 'bad', revision: 0, content: { ops: [] },
    pending: { opId: 'x', baseRevision: 0, original: {}, delta: {} } }),
  /未确认操作无效/)
  assert.equal(editor.client.clientId, 'one')
  assert.equal(editor.client.pending, null)
  editor.client.close()
})
