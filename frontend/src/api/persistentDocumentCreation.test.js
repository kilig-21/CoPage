import test from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createPersistentDocumentCreator } from './persistentDocumentCreation.js'
import { documentCreationTrackingKey } from './creationRequest.js'
import { createDocumentImporter } from './documentImport.js'

class Storage {
  data = new Map(); denySet = false; denyRemove = false; reads = []
  get length() { return this.data.size }
  key(n) { return [...this.data.keys()][n] ?? null }
  getItem(key) { this.reads.push(key); return this.data.get(key) ?? null }
  setItem(key, value) { if (this.denySet) throw Error('quota'); this.data.set(key, String(value)) }
  removeItem(key) { if (this.denyRemove) throw Error('blocked'); this.data.delete(key) }
}
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
function fixture() {
  const storage = new Storage(), session = new Storage(), receipts = new Map(), calls = [], queues = new Map(), lockContext = new AsyncLocalStorage()
  const state = { current: true, mode: 'drop', depth: 0, held: null, getHeld: null, badGet: null }, inputs = []
  async function withLock(key, action) {
    const previous = queues.get(key) ?? Promise.resolve(), gate = deferred()
    queues.set(key, gate.promise)
    await previous
    state.depth++
    try { return await lockContext.run(key, action) } finally { state.depth--; gate.resolve() }
  }
  const post = async (path, body, config) => {
    assert.equal(lockContext.getStore(), undefined, 'HTTP不能占有本请求的准备/清理锁')
    const uuid = config.headers['Idempotency-Key']; calls.push(['post', path, uuid]); inputs.push(body)
    if (state.mode === 'reject') throw { code: 400, message: 'rejected' }
    if (!receipts.has(uuid)) receipts.set(uuid, { id: receipts.size + 21, kind: path === '/doc/import' ? 'import' :
      path.startsWith('/personal-templates/') ? 'personal-template:' + path.split('/')[2] : 'document' })
    if (state.mode === 'drop') throw { code: 503, message: 'ack unavailable' }
    if (state.held) return state.held.promise
    return { code: 0, data: { id: state.mode === 'bad' ? 'wrong' : receipts.get(uuid).id } }
  }
  const get = async (path, config) => {
    assert.equal(lockContext.getStore(), undefined)
    calls.push(['get', path, config.copageExpectedSessionToken])
    if (state.getHeld) return state.getHeld.promise
    if (state.badGet) return state.badGet
    const uuid = path.split('/').at(-1), saved = receipts.get(uuid)
    if (!saved) throw { code: 404, message: 'not found yet' }
    return { code: 0, data: { ...saved, requestId: uuid.toLowerCase(), available: true, title: '后来修改的标题', deleted: false } }
  }
  const make = (tab = session) => createPersistentDocumentCreator({ getStorage: () => storage, getSessionStorage: () => tab,
    crypto: webcrypto, withLock, post, get })
  const options = (extra = {}) => ({ account: 'A', service: '/api', isCurrent: () => state.current,
    copageExpectedSessionToken: 'token-A', ...extra })
  return { storage, session, receipts, calls, state, inputs, make, options }
}

test('落库丢回复、关闭原标签后，仅凭持久元数据GET确认原编号，不再上传或创建', async () => {
  const f = fixture(), create = f.make()
  await assert.rejects(create.create('/doc', { title: '资料' }, f.options()))
  assert.equal(f.receipts.size, 1)
  const reopened = f.make(new Storage()), pending = await reopened.listPending(f.options())
  assert.equal(pending.records.length, 1); assert.equal(pending.unreadable, 0)
  const result = await reopened.confirm(pending.records[0], f.options())
  assert.equal(result.data.id, 21); assert.equal(result.data.title, '后来修改的标题')
  assert.deepEqual(f.calls.map(c => c[0]), ['post', 'get'])
  assert.equal((await reopened.listPending(f.options())).records.length, 0)
})

test('导入只持久化文件名和摘要，关页后无需原文件即可确认原导入', async () => {
  const f = fixture(), body = new FormData(), content = 'private body not for durable metadata 中文😀'
  body.append('file', new File([content], '资料.txt')); body.append('title', '导入标题')
  await assert.rejects(f.make().create('/doc/import', body, f.options()))
  const raw = [...f.storage.data.values()].join('')
  assert.equal(raw.includes(content), false); assert.equal(raw.includes('token-A'), false)
  const reopened = f.make(new Storage()), { records } = await reopened.listPending(f.options())
  assert.equal(records[0].filename, '资料.txt'); assert.equal(records[0].title, '导入标题')
  assert.equal((await reopened.confirm(records[0], f.options())).data.kind, 'import')
  assert.equal(f.calls.filter(c => c[0] === 'post').length, 1)
})

test('旧标签的普通UUID按同一内容衔接；只读取该槽，不读取草稿或凭据值', async () => {
  const f = fixture(), uuid = '12345678-abcd-4123-8123-123456789abc', body = { title: '旧资料' }
  const key = await documentCreationTrackingKey(webcrypto, { account: 'A', service: '/api', path: '/doc', body })
  f.session.setItem(key, uuid); f.storage.setItem('copage-draft:private', 'secret-body'); f.storage.setItem('collab-token', 'secret-token')
  await assert.rejects(f.make().create('/doc', body, f.options()))
  assert.equal(f.calls[0][2], uuid)
  await f.make(new Storage()).listPending(f.options())
  assert.equal(f.storage.reads.includes('collab-token'), false); assert.equal(f.storage.reads.includes('copage-draft:private'), false)
  assert.equal(f.storage.data.get('copage-draft:private'), 'secret-body')
})

test('私人模板的旧UUID和原版本保持；模板已更新也不把重试改为新版本', async () => {
  const f = fixture(), path = '/personal-templates/12/documents', body = { title: '模板资料', expectedVersion: 9 }
  const key = await documentCreationTrackingKey(webcrypto, { account: 'A', service: '/api', path, body: { title: body.title } })
  f.session.setItem(key, JSON.stringify({ requestId: '12345678-abcd-4123-8123-123456789abc', expectedVersion: 4 }))
  await assert.rejects(f.make().create(path, body, f.options()))
  assert.equal(f.inputs[0].expectedVersion, 4)
  const next = f.make(new Storage()), pending = await next.listPending(f.options())
  assert.equal((await next.confirm(pending.records[0], f.options())).data.kind, 'personal-template:12')
})

test('同一标签的重试沿用UUID；两个标签的独立同名创建仍是不同意图', async () => {
  const f = fixture(), one = f.make(), two = f.make(new Storage())
  await assert.rejects(one.create('/doc', { title: '相同' }, f.options()))
  await assert.rejects(one.create('/doc', { title: '相同' }, f.options()))
  await assert.rejects(two.create('/doc', { title: '相同' }, f.options()))
  assert.equal(f.calls[0][2], f.calls[1][2]); assert.notEqual(f.calls[0][2], f.calls[2][2])
  assert.equal(f.receipts.size, 2); assert.equal((await one.listPending(f.options())).records.length, 2)
})

test('同一标签并发准备不分配两份UUID，网络期间锁已释放', async () => {
  const f = fixture(), creator = f.make()
  const result = await Promise.allSettled([creator.create('/doc', {}, f.options()), creator.create('/doc', {}, f.options())])
  assert.ok(result.every(r => r.status === 'rejected')); assert.equal(f.calls.length, 2)
  assert.equal(f.calls[0][2], f.calls[1][2]); assert.equal(f.receipts.size, 1)
})

test('确认旧请求不清除当前标签另一项同名意图的UUID', async () => {
  const f = fixture(), old = f.make(), tab = new Storage(), next = f.make(tab)
  await assert.rejects(old.create('/doc', {}, f.options()))
  const original = (await next.listPending(f.options())).records[0]
  await assert.rejects(next.create('/doc', {}, f.options()))
  const slots = [...tab.data.entries()]
  await next.confirm(original, f.options())
  assert.deepEqual([...tab.data.entries()], slots)
  assert.equal((await next.listPending(f.options())).records.length, 1)
})

test('缺收据404和坏200都保持原记录，核对不自动重发', async () => {
  const f = fixture(), creator = f.make()
  await assert.rejects(creator.create('/doc', {}, f.options()))
  const record = (await creator.listPending(f.options())).records[0], saved = new Map(f.storage.data)
  const receipt = f.receipts.get(record.requestId); f.receipts.clear()
  await assert.rejects(creator.confirm(record, f.options()), e => e.code === 404)
  for (const data of [{ id: 21 }, { ...receipt, requestId: record.requestId, kind: 'import', available: true, title: 'x', deleted: false },
    { ...receipt, requestId: record.requestId, available: false, title: '不应暴露', deleted: false }]) {
    f.state.badGet = { code: 0, data }
    await assert.rejects(creator.confirm(record, f.options()), e => e.reason === 'DOCUMENT_CREATION_RESPONSE')
  }
  assert.deepEqual(f.storage.data, saved); assert.equal(f.calls.filter(c => c[0] === 'post').length, 1)
})

test('旧创建已经软删或当前不可用，只确认收据，不恢复、不新建', async () => {
  for (const current of [{ available: true, title: '回收站中的资料', deleted: true }, { available: false, title: null, deleted: false }]) {
    const f = fixture(), c = f.make(); await assert.rejects(c.create('/doc', {}, f.options()))
    const r = (await c.listPending(f.options())).records[0]
    f.state.badGet = { code: 0, data: { id: 21, requestId: r.requestId, kind: 'document', ...current } }
    assert.deepEqual((await c.confirm(r, f.options())).data, f.state.badGet.data)
    assert.equal(f.calls.filter(c => c[0] === 'post').length, 1)
  }
})

test('账号/服务隔离，旧列表对象不能作为新身份的核对凭据', async () => {
  const f = fixture(), c = f.make(); await assert.rejects(c.create('/doc', {}, f.options()))
  const r = (await c.listPending(f.options())).records[0], count = f.calls.length
  for (const scope of [{ account: 'B' }, { service: '/another-api' }]) {
    assert.equal((await c.listPending(f.options(scope))).records.length, 0)
    await assert.rejects(c.confirm(r, f.options(scope)), e => e.reason === 'DOCUMENT_CREATION_RECORD')
  }
  assert.equal(f.calls.length, count)
})

test('在途写入和只读确认后的身份变化均不清原记录或认作新身份成功', async () => {
  const f = fixture(), c = f.make(); f.state.mode = 'ok'; f.state.held = deferred()
  const writing = c.create('/doc', {}, f.options())
  while (!f.calls.length) await new Promise(resolve => setImmediate(resolve))
  f.state.current = false; f.state.held.resolve({ code: 0, data: { id: 21 } })
  await assert.rejects(writing, e => e.name === 'AbortError')
  f.state.current = true
  const r = (await c.listPending(f.options())).records[0]; f.state.getHeld = deferred()
  const reading = c.confirm(r, f.options()); f.state.current = false
  f.state.getHeld.reject({ code: 403, message: 'original denied' })
  await assert.rejects(reading, e => e.name === 'AbortError')
  assert.equal(f.storage.data.size, 1)
})

test('持久存储失败、旧UUID损坏或元数据含正文时均不发送请求', async () => {
  const f = fixture(), c = f.make(); f.storage.denySet = true
  await assert.rejects(c.create('/doc', {}, f.options())); assert.equal(f.calls.length, 0)
  f.storage.denySet = false
  await assert.rejects(c.create('/doc', { title: 'x', content: '不应持久化' }, f.options()))
  const key = await documentCreationTrackingKey(webcrypto, { account: 'A', service: '/api', path: '/doc', body: { title: '坏槽' } })
  f.session.setItem(key, 'bad-uuid')
  await assert.rejects(c.create('/doc', { title: '坏槽' }, f.options()))
  assert.equal(f.calls.length, 0); assert.equal(f.session.data.get(key), 'bad-uuid')
})

test('损坏记录可单独提示，不读取其它命名空间，也不吞掉可用记录', async () => {
  const f = fixture(), c = f.make(); await assert.rejects(c.create('/doc', {}, f.options()))
  f.storage.setItem('copage-document-create:v1:%2Fapi:A:broken', '{bad-json')
  f.storage.setItem('copage-document-create:v1:%2Fapi:B:other', 'unrelated')
  const pending = await c.listPending(f.options())
  assert.equal(pending.records.length, 1); assert.equal(pending.unreadable, 1)
  assert.equal(f.storage.reads.includes('copage-document-create:v1:%2Fapi:B:other'), false)
})

test('明确首次拒绝结束本次记录，已有未知请求再遇拒绝仍保留', async () => {
  const f = fixture(), c = f.make(); f.state.mode = 'reject'
  await assert.rejects(c.create('/doc', {}, f.options({ deferCleanup: true })))
  assert.equal(f.storage.data.size, 0); assert.equal(f.session.data.size, 0)
  f.state.mode = 'drop'; await assert.rejects(c.create('/doc', {}, f.options()))
  f.state.mode = 'reject'; await assert.rejects(c.create('/doc', {}, f.options()))
  assert.equal(f.storage.data.size, 1)
})

test('成功后清理失败明确警告，恢复存储后只读确认仍可结束原记录', async () => {
  const f = fixture(), c = f.make(); f.state.mode = 'ok'; f.storage.denyRemove = true
  const result = await c.create('/doc', {}, f.options())
  assert.equal(result.data.id, 21); assert.ok(result.creationTrackingWarning)
  f.storage.denyRemove = false
  const reopened = f.make(new Storage()), r = (await reopened.listPending(f.options())).records[0]
  await reopened.confirm(r, f.options()); assert.equal(f.storage.data.size, 0)
  await reopened.create('/doc', {}, f.options()); assert.equal(f.receipts.size, 2)
})

test('明确结束等待只移除本请求元数据，不取消已落库创建或触碰其它待确认意图', async () => {
  const f = fixture(), c = f.make(), other = f.make(new Storage())
  await assert.rejects(c.create('/doc', { title: '第一项' }, f.options()))
  await assert.rejects(other.create('/doc', { title: '第二项' }, f.options()))
  const first = (await c.listPending(f.options())).records.find(r => r.title === '第一项'), count = f.calls.length
  assert.deepEqual(await c.endWaiting(first, f.options()), { ended: true })
  assert.equal(f.calls.length, count); assert.equal(f.receipts.size, 2)
  assert.equal((await other.listPending(f.options())).records[0].title, '第二项')
})

test('结束等待遇到记录变化或身份变化时不得清除记录', async () => {
  const f = fixture(), c = f.make(); await assert.rejects(c.create('/doc', {}, f.options()))
  const record = (await c.listPending(f.options())).records[0], value = JSON.parse(f.storage.data.get(record.key))
  f.storage.data.set(record.key, JSON.stringify({ ...value, createdAt: value.createdAt + 1 }))
  const before = new Map(f.storage.data), slots = new Map(f.session.data)
  await assert.rejects(c.endWaiting(record, f.options()), e => e.reason === 'DOCUMENT_CREATION_CHANGED')
  f.state.current = false
  await assert.rejects(c.endWaiting(record, f.options()), e => e.name === 'AbortError')
  assert.deepEqual(f.storage.data, before); assert.deepEqual(f.session.data, slots)
})

test('重开导入窗口后原未知请求遭业务拒绝，仍冻结原文件和原标题直到确认', async () => {
  const f = fixture(), c = f.make(), file = new File(['original body'], 'original.txt')
  const makeImporter = () => createDocumentImporter({
    readIdentity: () => ({ account: 'A', token: 'token-A', service: '/api' }),
    create: (path, body, config) => c.create(path, body, f.options(config)),
  })
  await assert.rejects(makeImporter().submit({ file, title: '原标题' }), e => e.uncertain === true)
  f.state.mode = 'reject'
  const reopened = makeImporter()
  await assert.rejects(reopened.submit({ file, title: '原标题' }), e => e.code === 400 && e.uncertain === true)
  assert.equal(reopened.getSnapshot().status, 'uncertain')
  assert.equal(reopened.getSnapshot().filename, 'original.txt')
  f.state.mode = 'ok'
  await reopened.submit({ file: new File(['changed body'], 'changed.txt'), title: '不能替换原标题' })
  assert.equal(f.inputs.at(-1).get('title'), '原标题')
  assert.equal(await f.inputs.at(-1).get('file').text(), 'original body')
  assert.equal(new Set(f.calls.filter(c => c[0] === 'post').map(c => c[2])).size, 1)
  assert.equal(f.receipts.size, 1)
})
