import test from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { createCopyCreator } from './copyCreation.js'
import { documentCreationTrackingKey } from './creationRequest.js'

const options = { account: 'owner', service: '/api' }, body = { title: '原副本🧭' }
const response = { data: { id: 41, title: body.title, sourceRevision: 7 } }
const lost = async () => { throw Error('lost') }
const pending = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function storage() {
  const values = new Map(), reads = []
  return { values, reads, get length() { return values.size }, key: i => [...values.keys()][i] ?? null,
    getItem: key => { reads.push(key); return values.get(key) ?? null }, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
}
function fixture() {
  const durable = storage(), session = storage()
  const dependencies = { getStorage: () => durable, getLegacyStorage: () => session, crypto: webcrypto, post: lost }
  return { durable, session, dependencies, creator: () => createCopyCreator(dependencies) }
}
async function oldRecord(f) {
  const creator = createCopyCreator({ getStorage: () => f.session, crypto: webcrypto, post: lost })
  await assert.rejects(creator.create(12, body, options))
  return [...f.session.values][0]
}
test('旧标签完整原请求核验落盘后迁移，关页清空session仍同UUID确认一份原副本', async () => {
  const f = fixture(), [key, raw] = await oldRecord(f)
  f.session.values.set('copage-draft:v1:owner:26:tab', '草稿')
  const creator = f.creator(), [record] = await creator.listPending(options)
  assert.equal(record.requestId, JSON.parse(raw).requestId); assert.equal(f.durable.values.get(key), raw)
  assert.equal(f.session.values.get(key), undefined); assert.equal(f.session.values.get('copage-draft:v1:owner:26:tab'), '草稿')
  f.session.values.clear(); let sent
  f.dependencies.post = async (_, input, config) => { sent = { input, id: config.headers['Idempotency-Key'] }; return response }
  const reopened = f.creator(), [resumed] = await reopened.listPending(options)
  assert.equal((await reopened.retry(resumed, options)).data.id, 41)
  assert.deepEqual(sent, { input: body, id: record.requestId }); assert.equal(f.durable.values.size, 0)
})
test('旧UUID槽匹配原来源及标题才续接，成功清理两个存储中的对应UUID', async () => {
  const f = fixture(), key = await documentCreationTrackingKey(webcrypto, { ...options, path: '/doc/12/copy', body })
  const uuid = webcrypto.randomUUID(); f.session.values.set(key, uuid)
  let sent; f.dependencies.post = async (_, __, config) => { sent = config.headers['Idempotency-Key']; return response }
  assert.equal((await f.creator().create(12, body, options)).data.id, 41)
  assert.equal(sent, uuid); assert.equal(f.session.values.size, 0); assert.equal(f.durable.values.size, 0)
})
test('迁移写失败或读回不符保留完整旧记录且零网络；旧新冲突不覆盖任何一份', async () => {
  for (const mode of ['throw', 'silent', 'conflict']) {
    const f = fixture(), [key, raw] = await oldRecord(f); let calls = 0
    f.dependencies.post = async () => { calls++; return response }
    if (mode === 'throw') f.durable.setItem = () => { throw Error('denied') }
    if (mode === 'silent') f.durable.setItem = () => {}
    const different = JSON.stringify({ ...JSON.parse(raw), requestId: webcrypto.randomUUID() })
    if (mode === 'conflict') f.durable.values.set(key, different)
    await assert.rejects(f.creator().listPending(options))
    assert.equal(f.session.values.get(key), raw); assert.equal(calls, 0)
    if (mode === 'conflict') assert.equal(f.durable.values.get(key), different)
  }
})
test('新记录没有可靠落盘时不发送，不降级为只在内存或标签中保存', async () => {
  for (const mode of ['get', 'silent']) {
    const f = fixture(); let calls = 0; f.dependencies.post = async () => { calls++; return response }
    if (mode === 'get') f.dependencies.getStorage = () => { throw Error('denied') }
    else f.durable.setItem = () => {}
    await assert.rejects(f.creator().create(12, body, options)); assert.equal(calls, 0); assert.equal(f.session.values.size, 0)
  }
})
test('旧记录扫描只取当前账号服务，不读其他账号、正文草稿或凭据值', async () => {
  const f = fixture(), [key] = await oldRecord(f)
  const other = key.replace(':owner:', ':other:'); f.session.values.set(other, 'private'); f.session.values.set('collab-token', 'private')
  f.session.reads.length = 0
  assert.equal((await f.creator().listPending(options)).length, 1)
  assert.ok(f.session.reads.every(k => k === key)); assert.equal(f.session.values.get(other), 'private')
})
test('双标签准备共用一个原UUID，锁不跨HTTP等待，关闭一标签不靠自动重发', async () => {
  const f = fixture(), queues = new Map(), gate = pending(), started = pending(), requests = []; let held = 0
  f.dependencies.withLock = (key, action) => {
    const before = queues.get(key) ?? Promise.resolve()
    const next = before.then(async () => { held++; try { return await action() } finally { held-- } })
    queues.set(key, next.catch(() => {})); return next
  }
  f.dependencies.post = async (_, __, config) => { assert.equal(held, 0); requests.push(config.headers['Idempotency-Key']); started.resolve(); await gate.promise; throw Error('lost') }
  const a = f.creator().create(12, body, options); await started.promise
  const b = f.creator().create(12, body, options)
  while (requests.length < 2) await new Promise(resolve => setImmediate(resolve))
  gate.resolve(); await Promise.allSettled([a, b])
  assert.equal(new Set(requests).size, 1); assert.equal(f.durable.values.size, 1)
  assert.equal((await f.creator().listPending(options)).length, 1); assert.equal(requests.length, 2)
})
test('等待锁时取消或换身份不写入、不发送；确认清理锁失败仍明确已创建并保留原记录', async () => {
  const f = fixture(), gate = pending(); let current = true, calls = 0
  f.dependencies.withLock = async (_, action) => { await gate.promise; return action() }
  f.dependencies.post = async () => { calls++; return response }
  const task = f.creator().create(12, body, { ...options, isCurrent: () => current }); current = false; gate.resolve()
  await assert.rejects(task, e => e.name === 'AbortError'); assert.equal(calls, 0); assert.equal(f.durable.values.size, 0)
  f.dependencies.withLock = (_, action) => action()
  const creator = f.creator(), result = await creator.create(12, body, { ...options, deferCleanup: true })
  // This creator reads the injected dependency once; use a lock whose behavior can change.
  let fail = false; f.dependencies.withLock = (_, action) => fail ? Promise.reject(Error('lock failed')) : action()
  const next = f.creator(), confirmed = await next.create(12, body, { ...options, deferCleanup: true })
  fail = true; const final = await confirmed.confirmTracking()
  assert.equal(final.data.id, 41); assert.match(final.creationTrackingWarning, /副本已创建/); assert.equal(f.durable.values.size, 1)
  assert.equal(result.data.id, 41)
})
