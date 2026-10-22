import test from 'node:test'
import assert from 'node:assert/strict'
import { subscribeProjectDocumentEvents } from './projectDocumentEvents.js'

const service = '/api', account = 'synthetic owner'
const prefix = `copage-project-document:v1:${encodeURIComponent(service)}:${encodeURIComponent(account)}:`
const recordKey = prefix + 'a'.repeat(64)
function fixture() {
  const values = new Map([['collab-user', account], ['collab-token', 'synthetic-token'], [recordKey, 'original-record']])
  const listeners = new Map(), controller = new AbortController()
  let reads = 0, reloads = 0, cancellations = 0, unreadable = false, inaccessible = false
  const storage = { getItem(key) { if (unreadable) throw Error('denied'); return values.get(key) ?? null } }
  const eventTarget = {
    addEventListener(type, handler) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(handler) },
    removeEventListener(type, handler) { listeners.get(type)?.delete(handler) },
  }
  const dispose = subscribeProjectDocumentEvents({ eventTarget,
    getStorage: () => { if (inaccessible) throw Error('denied'); return storage },
    readIdentity: () => { reads++; return { account: storage.getItem('collab-user'), token: storage.getItem('collab-token'), service } },
    onIdentityInvalidated: () => { cancellations++; controller.abort() }, onRecordsChanged: () => { reloads++ },
  })
  const emit = (type, event = {}) => { for (const handler of [...listeners.get(type) || []]) handler(event) }
  return { values, storage, listeners, controller, dispose, emit,
    event: (key, extra = {}) => emit('storage', { key, storageArea: storage, ...extra }),
    unreadable: value => { unreadable = value }, inaccessible: value => { inaccessible = value },
    state: () => ({ reads, reloads, cancellations }),
  }
}

test('另一标签的普通草稿更新不取消等待的原确认、不重扫且不读取身份', async () => {
  const f = fixture(), before = f.state()
  let release, accepted = 0
  const response = new Promise(resolve => { release = resolve })
  const confirmation = response.then(() => { if (!f.controller.signal.aborted) accepted++ })
  f.event('copage-draft:v1:synthetic%20owner:900001:client')
  f.event('unrelated-setting')
  assert.deepEqual(f.state(), before); assert.equal(f.controller.signal.aborted, false)
  assert.equal(f.values.get(recordKey), 'original-record')
  release(); await confirmation
  assert.equal(accepted, 1); f.dispose()
})

test('忽略sessionStorage、其他服务、其他账号及相似账号前缀', () => {
  const f = fixture(), before = f.state()
  f.event('collab-token', { storageArea: {} })
  f.event(null, { storageArea: {} })
  f.event(recordKey, { storageArea: {} })
  f.event(`copage-project-document:v1:${encodeURIComponent('/other-api')}:${encodeURIComponent(account)}:` + 'a'.repeat(64))
  f.event('copage-project-document:v1:%2Fapi:another-owner:' + 'a'.repeat(64))
  f.event(prefix.slice(0, -1) + '-other:' + 'a'.repeat(64))
  assert.deepEqual(f.state(), before); assert.equal(f.controller.signal.aborted, false); f.dispose()
})

test('当前账号服务的原槽事件仅重扫，原确认和槽内容保持', () => {
  const f = fixture()
  f.event(recordKey, { newValue: null })
  assert.deepEqual(f.state(), { reads: 1, reloads: 1, cancellations: 0 })
  assert.equal(f.controller.signal.aborted, false); assert.equal(f.values.get(recordKey), 'original-record'); f.dispose()
})

for (const key of ['collab-user', 'collab-token']) test(`${key}真实变化取消原确认并重扫，随后只接受新账号前缀`, () => {
  const f = fixture()
  f.values.set(key, 'replacement')
  f.event(key, { newValue: 'irrelevant queued value' })
  assert.equal(f.controller.signal.aborted, true)
  assert.deepEqual(f.state(), { reads: 2, reloads: 1, cancellations: 1 })
  assert.equal(f.values.get(recordKey), 'original-record')
  if (key === 'collab-user') {
    f.event(recordKey)
    assert.equal(f.state().reloads, 1)
    f.event('copage-project-document:v1:%2Fapi:replacement:' + 'b'.repeat(64))
    assert.equal(f.state().reloads, 2)
  }
  f.dispose()
})

test('清空后身份缺失取消；排队旧clear但当前身份仍有效时只重扫', () => {
  const f = fixture()
  f.event(null)
  assert.deepEqual(f.state(), { reads: 2, reloads: 1, cancellations: 0 })
  f.values.delete('collab-token'); f.event(null)
  assert.deepEqual(f.state(), { reads: 3, reloads: 2, cancellations: 1 })
  assert.equal(f.values.get(recordKey), 'original-record'); f.dispose()
})

test('身份读取异常取消并重扫，不删除原记录', () => {
  const f = fixture()
  f.unreadable(true); f.event('collab-token')
  assert.equal(f.controller.signal.aborted, true)
  assert.deepEqual(f.state(), { reads: 2, reloads: 1, cancellations: 1 })
  assert.equal(f.values.get(recordKey), 'original-record'); f.dispose()
})

test('取得localStorage异常时相关身份事件仍取消，不让异常逃逸', () => {
  const f = fixture()
  f.inaccessible(true); f.event('collab-user')
  assert.equal(f.controller.signal.aborted, true)
  assert.equal(f.state().reloads, 1); assert.equal(f.values.get(recordKey), 'original-record'); f.dispose()
})

test('排队旧身份事件按当前存储核对，当前身份未变不取消也不重扫', () => {
  const f = fixture()
  f.event('collab-token', { newValue: null })
  f.event('collab-user', { newValue: 'old account' })
  assert.deepEqual(f.state(), { reads: 3, reloads: 0, cancellations: 0 })
  assert.equal(f.controller.signal.aborted, false); f.dispose()
})

test('显式auth失效仍取消；同页原创建记录通知仅重扫', () => {
  const f = fixture()
  f.emit('copage-project-documents-changed')
  assert.deepEqual(f.state(), { reads: 1, reloads: 1, cancellations: 0 })
  f.emit('copage-auth-changed')
  assert.deepEqual(f.state(), { reads: 2, reloads: 2, cancellations: 1 })
  assert.equal(f.controller.signal.aborted, true); f.dispose()
})

test('dispose移除所有监听，已排队回调不读身份也不取消或重扫', () => {
  const f = fixture(), queued = [...f.listeners.values()].flatMap(handlers => [...handlers]), before = f.state()
  f.dispose(); f.dispose()
  assert.ok([...f.listeners.values()].every(handlers => handlers.size === 0))
  f.values.delete('collab-token')
  for (const handler of queued) handler({ storageArea: f.storage, key: 'collab-token' })
  f.event(null); f.emit('copage-auth-changed'); f.emit('copage-project-documents-changed')
  assert.deepEqual(f.state(), before); assert.equal(f.controller.signal.aborted, false)
})
