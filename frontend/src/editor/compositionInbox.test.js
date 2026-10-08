import assert from 'node:assert/strict'
import test from 'node:test'
import Delta from 'quill-delta'
import CollabClient from '../ws/CollabClient.js'
import { createCompositionInbox } from './compositionInbox.js'

test('组合输入先提交本地差异，再按原顺序处理远端操作和确认', () => {
  let content = new Delta().insert('基线\n')
  let composing = true
  const client = new CollabClient({ docId: 1, clientId: 'ime', Delta,
    onRemote: operation => { content = content.compose(operation) } })
  client.attachSocket({ send: () => true })
  client.state = 'ready'
  const inbox = createCompositionInbox({ isComposing: () => composing,
    deliver: message => client.receive(message), resync: () => client.join() })
  const local = new Delta().retain(2).insert('输入中')
  content = content.compose(local)
  inbox.receive({ type: 'op', docId: 1, originClientId: 'other', revision: 1,
    op: new Delta().insert('远端|') })
  assert.equal(content.ops[0].insert, '基线输入中\n')
  assert.equal(client.revision, 0)
  client.submit(local)
  inbox.receive({ type: 'ack', docId: 1, clientId: 'ime',
    opId: client.pending.opId, revision: 2 })
  composing = false
  inbox.drain()
  assert.equal(content.ops[0].insert, '远端|基线输入中\n')
  assert.equal(client.revision, 2)
  assert.equal(client.hasUnconfirmedChanges(), false)
  client.close()
})

for (const urgent of [{ type: 'permission', permission: 1 }, { type: 'error', code: 403 }, { type: 'error', code: 401 }]) {
  test(`${urgent.type}立即处理并丢弃旧队列，结束输入后重新同步`, () => {
    let composing = true
    const delivered = []
    let syncs = 0
    const inbox = createCompositionInbox({ isComposing: () => composing,
      deliver: message => delivered.push(message), resync: () => syncs++ })
    inbox.receive({ type: 'op', revision: 1 })
    inbox.receive(urgent)
    inbox.receive({ type: 'op', revision: 2 })
    assert.deepEqual(delivered, [urgent])
    composing = false
    inbox.drain()
    inbox.drain()
    assert.deepEqual(delivered, [urgent])
    assert.equal(syncs, 1)
  })
}

test('恢复编辑权限按序等待组合输入结束，不提前结束输入批次', () => {
  let composing = true
  const delivered = []
  const inbox = createCompositionInbox({ isComposing: () => composing,
    deliver: message => delivered.push(message), resync: () => assert.fail('无需重同步') })
  const messages = [{ type: 'op', revision: 1 }, { type: 'permission', permission: 2 }]
  messages.forEach(message => inbox.receive(message))
  assert.deepEqual(delivered, [])
  composing = false
  inbox.drain()
  assert.deepEqual(delivered, messages)
})

test('长时间输入超出队列上限时重新同步；断线清空避免旧连接消息重放', () => {
  let composing = true
  const delivered = []
  let syncs = 0
  const inbox = createCompositionInbox({ isComposing: () => composing,
    deliver: message => delivered.push(message), resync: () => syncs++, maxMessages: 2 })
  for (let revision = 1; revision <= 10000; revision++) inbox.receive({ type: 'op', revision })
  composing = false
  inbox.drain()
  assert.equal(syncs, 1)
  assert.deepEqual(delivered, [])
  composing = true
  inbox.receive({ type: 'op', revision: 10001 })
  inbox.clear()
  composing = false
  inbox.drain()
  inbox.receive({ type: 'sync', revision: 10001 })
  assert.deepEqual(delivered, [{ type: 'sync', revision: 10001 }])
  assert.equal(syncs, 1)
})
