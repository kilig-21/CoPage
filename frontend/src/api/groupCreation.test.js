import test from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { createGroupCreator } from './groupCreation.js'

const body = { name: ' 小组😀 ', description: ' 原简介\n第二行 ' }
const response = { data: { id: 41, archived: false } }
const lost = async () => { throw Error('lost reply') }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function fixture(post = lost) {
  const values = new Map([['copage-draft:v1:owner:26:tab', '原草稿'], ['copage-project-create:v1:other', '项目原记录']])
  const reads = [], removes = []; let sequence = 0
  const storage = { get length() { return values.size }, key: index => [...values.keys()][index] ?? null,
    getItem: key => { reads.push(key); return values.get(key) ?? null },
    setItem: (key, value) => values.set(key, value), removeItem: key => { removes.push(key); values.delete(key) } }
  const crypto = { subtle: webcrypto.subtle, randomUUID: () => '00000000-0000-4000-8000-' + String(++sequence).padStart(12, '0') }
  const dependencies = { getStorage: () => storage, crypto, post }
  return { values, reads, removes, storage, crypto, dependencies, creator: createGroupCreator(dependencies),
    reload: () => createGroupCreator(dependencies), options: { account: 'owner', service: '/api' } }
}
const rows = f => [...f.values].filter(([key]) => key.startsWith('copage-group-create:'))

test('提交成功但回复丢失，重挂与重登只确认一份原小组，确认后主动同内容创建换UUID', async () => {
  const requests = [], receipts = new Map(); let lose = true
  const f = fixture(async (path, input, config) => {
    const uuid = config.headers['Idempotency-Key']; requests.push({ path, input, uuid })
    if (!receipts.has(uuid)) receipts.set(uuid, { data: { id: 41 + receipts.size, archived: false } })
    if (lose) throw Error('lost'); return receipts.get(uuid)
  })
  await assert.rejects(f.creator.create(body, f.options))
  await assert.rejects(f.creator.create(body, f.options))
  const reload = f.reload(), row = (await reload.listPending(f.options))[0]
  assert.equal(Object.isFrozen(row), true); assert.equal(Object.isFrozen(row.body), true)
  assert.deepEqual(row.body, body); assert.equal(row.name, body.name); assert.equal(row.description, body.description)
  lose = false
  assert.equal((await reload.retry(row, f.options)).data.id, 41)
  assert.equal(receipts.size, 1); assert.equal(rows(f).length, 0)
  assert.equal(new Set(requests.map(r => r.uuid)).size, 1)
  assert.ok(requests.every(r => r.path === '/groups')); assert.ok(requests.every(r => JSON.stringify(r.input) === JSON.stringify(body)))
  assert.equal((await reload.create(body, f.options)).data.id, 42)
  assert.notEqual(requests.at(-1).uuid, row.requestId)
  assert.equal(f.values.get('copage-draft:v1:owner:26:tab'), '原草稿')
  assert.equal(f.values.get('copage-project-create:v1:other'), '项目原记录')
})

test('所有请求失败码与取消拒绝都保留原请求，403/404不能生成替代UUID', async () => {
  for (const code of [400, 401, 403, 404, 409, 503]) {
    const ids = [], f = fixture(async (_, __, config) => { ids.push(config.headers['Idempotency-Key']); throw { code } })
    await assert.rejects(f.creator.create(body, f.options))
    const row = (await f.creator.listPending(f.options))[0], raw = f.values.get(row.key)
    await assert.rejects(f.creator.retry(row, f.options), e => e.code === code)
    assert.equal(f.values.get(row.key), raw); assert.equal(ids[0], ids[1]); assert.equal(rows(f).length, 1)
  }
})

test('首个await前冻结输入，保留空白和属性顺序无关，同标签并行准备复用UUID', async () => {
  const requests = [], f = fixture(async (_, input, config) => { requests.push({ input, uuid: config.headers['Idempotency-Key'] }); throw Error('lost') })
  const mutable = { ...body }, first = f.creator.create(mutable, f.options)
  mutable.name = '修改'; mutable.description = '修改'
  await assert.rejects(first)
  await Promise.allSettled([f.creator.create(body, f.options), f.creator.create({ description: body.description, name: body.name }, f.options)])
  assert.deepEqual(requests.map(r => r.input), [body, body, body]); assert.equal(new Set(requests.map(r => r.uuid)).size, 1)
  await assert.rejects(f.creator.create({ name: body.name.trim(), description: body.description.trim() }, f.options))
  assert.equal(rows(f).length, 2); assert.notEqual(requests[2].uuid, requests[3].uuid)
})

test('不同账号与服务独立枚举，不读取其它namespace；伪造和跨实例摘要不接受', async () => {
  const f = fixture(), variants = [f.options, { ...f.options, account: 'other:😀%' }, { ...f.options, service: 'https://example/api:%' }]
  for (const options of variants) await assert.rejects(f.creator.create(body, options))
  f.reads.length = 0
  const row = (await f.creator.listPending(f.options))[0]
  assert.equal(f.reads.every(key => key === row.key), true)
  const count = f.reads.length
  for (const options of variants.slice(1)) await assert.rejects(f.creator.retry(row, options), e => e.reason === 'GROUP_CREATION_RECORD')
  await assert.rejects(f.creator.retry({ ...row }, f.options), e => e.reason === 'GROUP_CREATION_RECORD')
  await assert.rejects(f.reload().retry(row, f.options), e => e.reason === 'GROUP_CREATION_RECORD')
  assert.equal(f.reads.length, count)
})

test('原槽消失、UUID或body变更、坏记录均不覆盖不发送替代请求', async () => {
  let calls = 0; const f = fixture(async () => { calls++; throw Error('lost') })
  await assert.rejects(f.creator.create(body, f.options))
  const row = (await f.creator.listPending(f.options))[0], raw = f.values.get(row.key), parsed = JSON.parse(raw)
  for (const changed of [null, '{bad', JSON.stringify({ ...parsed, requestId: f.crypto.randomUUID() }),
    JSON.stringify({ ...parsed, name: '改名' }), JSON.stringify({ ...parsed, description: '改简介' })]) {
    if (changed === null) f.values.delete(row.key); else f.values.set(row.key, changed)
    await assert.rejects(f.creator.retry(row, f.options), e => e.reason === 'GROUP_CREATION_CHANGED')
    assert.equal(f.values.get(row.key) ?? null, changed)
  }
  assert.equal(calls, 1)
})

test('onPrepared在持久保存后收到冻结原摘要，retry保持对象引用且内部options不发送', async () => {
  let prepared, same; const f = fixture(async (path, input, config) => {
    assert.equal(path, '/groups'); assert.deepEqual(input, body)
    assert.equal(JSON.parse(f.values.get(prepared.key)).requestId, prepared.requestId)
    assert.equal(config.headers['Idempotency-Key'], prepared.requestId)
    assert.equal(config.headers.Custom, 'yes'); assert.equal(config.timeout, 12); assert.equal(config.copageExpectedSessionToken, 'captured')
    for (const key of ['account', 'service', 'isCurrent', 'onPrepared', 'deferCleanup']) assert.equal(Object.hasOwn(config, key), false)
    return response
  })
  const options = { ...f.options, onPrepared: row => { prepared = row }, deferCleanup: true, timeout: 12,
    copageExpectedSessionToken: 'captured', headers: { Custom: 'yes', 'Idempotency-Key': 'wrong' } }
  await f.creator.create(body, options)
  const row = (await f.creator.listPending(f.options))[0]
  await f.creator.retry(row, { ...options, onPrepared: next => { prepared = next; same = next } })
  assert.equal(same, row)
})

test('准备回调失败/改槽/取消/切身份时不发送，已存原记录保留', async () => {
  for (const mode of ['throw', 'changed', 'abort', 'identity']) {
    let calls = 0, current = true; const controller = new AbortController(), f = fixture(async () => { calls++; return response })
    await assert.rejects(f.creator.create(body, { ...f.options, signal: controller.signal, isCurrent: () => current,
      onPrepared: row => { if (mode === 'throw') throw Error('callback'); if (mode === 'changed') f.values.set(row.key, '{changed')
        if (mode === 'abort') controller.abort(); if (mode === 'identity') current = false } }))
    assert.equal(calls, 0); assert.equal(rows(f).length, 1)
  }
})

test('取消/切换/身份不可读后的迟到200不清记录，重新读取可确认原UUID', async () => {
  for (const mode of ['abort', 'changed', 'denied']) {
    const wait = deferred(), started = deferred(); let current = true, denied = false
    const f = fixture(() => { started.resolve(); return wait.promise }), controller = new AbortController()
    const promise = f.creator.create(body, { ...f.options, signal: controller.signal,
      isCurrent: () => { if (denied) throw Error('identity denied'); return current } })
    await started.promise
    const raw = rows(f)[0][1]
    if (mode === 'abort') controller.abort(); if (mode === 'changed') current = false; if (mode === 'denied') denied = true
    wait.resolve(response)
    await assert.rejects(promise, e => e.name === 'AbortError'); assert.equal(rows(f)[0][1], raw)
    const reload = f.reload(), row = (await reload.listPending(f.options))[0]
    assert.equal(row.requestId, JSON.parse(raw).requestId); assert.equal((await reload.retry(row, f.options)).data.id, 41)
  }
})

test('坏200严格拒绝正安全整数id与boolean archived以外结果，原UUID可再次确认', async () => {
  for (const data of [null, {}, { id: 0, archived: false }, { id: '41', archived: false },
    { id: Number.MAX_SAFE_INTEGER + 1, archived: false }, { id: 1.5, archived: false },
    { id: 41, archived: null }, { id: 41, archived: 0 }, { id: 41, archived: 'false' }]) {
    let bad = true; const ids = [], f = fixture(async (_, __, config) => { ids.push(config.headers['Idempotency-Key']); return bad ? { data } : response })
    await assert.rejects(f.creator.create(body, f.options), e => e.reason === 'GROUP_CREATION_RESPONSE')
    bad = false
    const reload = f.reload(), row = (await reload.listPending(f.options))[0]
    assert.equal((await reload.retry(row, f.options)).data.id, 41); assert.equal(new Set(ids).size, 1)
  }
  const f = fixture(async () => ({ data: { id: 41, archived: true } }))
  assert.equal((await f.creator.create(body, f.options)).data.archived, true)
})

test('读取/保存失败不发送；坏枚举或不可读不会伪装空列表', async () => {
  for (const method of ['getStorage', 'getItem', 'setItem']) {
    let calls = 0; const f = fixture(async () => { calls++; return response })
    if (method === 'getStorage') f.dependencies.getStorage = () => { throw Error('blocked') }
    else f.storage[method] = () => { throw Error('blocked') }
    await assert.rejects(f.reload().create(body, f.options), e => e.reason === 'GROUP_CREATION_STORAGE')
    assert.equal(calls, 0); assert.equal(rows(f).length, 0)
  }
  const f = fixture(); assert.deepEqual(await f.creator.listPending(f.options), [])
  await assert.rejects(f.creator.create(body, f.options))
  const originalKey = f.storage.key
  f.storage.key = () => { throw Error('blocked') }
  await assert.rejects(f.creator.listPending(f.options), e => e.reason === 'GROUP_CREATION_STORAGE')
  f.storage.key = originalKey
  Object.defineProperty(f.storage, 'length', { get: () => -1 })
  await assert.rejects(f.creator.listPending(f.options), e => e.reason === 'GROUP_CREATION_STORAGE')
})

test('记录字段/大小/时间/UUID及内容指纹严格校验，发现坏记录不返回部分清单', async () => {
  const f = fixture(); await assert.rejects(f.creator.create(body, f.options))
  await assert.rejects(f.creator.create({ name: '另一个', description: '' }, f.options))
  const [key, raw] = rows(f)[0], parsed = JSON.parse(raw)
  const invalid = [{ ...parsed, version: 2 }, { ...parsed, requestId: 'bad' }, { ...parsed, name: '' },
    { ...parsed, name: '改名' }, { ...parsed, description: '改简介' }, { ...parsed, createdAt: 0 },
    { ...parsed, createdAt: Date.now() + 100000 }, { ...parsed, token: 'forbidden' },
    { ...parsed, description: null }, { ...parsed, name: '名'.repeat(81) }]
  delete invalid[0].description
  for (const item of invalid) {
    const changed = JSON.stringify(item); f.values.set(key, changed)
    await assert.rejects(f.creator.listPending(f.options), e => e.reason === 'GROUP_CREATION_RECORD')
    await assert.rejects(f.creator.create(body, f.options), e => e.reason === 'GROUP_CREATION_RECORD')
    assert.equal(f.values.get(key), changed)
  }
  f.values.set(key, raw + ' '.repeat(4096))
  await assert.rejects(f.creator.listPending(f.options), e => e.reason === 'GROUP_CREATION_RECORD')
  f.values.delete(key); const wrong = key.slice(0, -1) + (key.endsWith('0') ? '1' : '0'); f.values.set(wrong, raw)
  await assert.rejects(f.creator.listPending(f.options), e => e.reason === 'GROUP_CREATION_RECORD')
})

test('扫描中身份变化不返回摘要，已取消或身份不可读时不读取原账号槽', async () => {
  const f = fixture(); await assert.rejects(f.creator.create(body, f.options))
  let current = true; const keyMethod = f.storage.key
  f.storage.key = index => { current = false; return keyMethod(index) }
  await assert.rejects(f.creator.listPending({ ...f.options, isCurrent: () => current }), e => e.name === 'AbortError')
  f.storage.key = keyMethod; f.reads.length = 0
  await assert.rejects(f.creator.listPending({ ...f.options, isCurrent: () => { throw Error('denied') } }), e => e.name === 'AbortError')
  assert.equal(f.reads.length, 0)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(f.creator.create(body, { ...f.options, signal: controller.signal }), e => e.name === 'AbortError')
})

test('延后确认同步清理，清理后不再读取身份，重复确认仍返回已知成功', async () => {
  let fail = false; const f = fixture(async () => response)
  const result = await f.creator.create(body, { ...f.options, deferCleanup: true,
    isCurrent: () => { if (fail) throw Error('identity denied'); return true } })
  assert.equal(rows(f).length, 1)
  const remove = f.storage.removeItem; f.storage.removeItem = key => { remove(key); fail = true }
  const confirmed = result.confirmTracking()
  assert.equal(confirmed instanceof Promise, false); assert.equal(confirmed.data.id, 41); assert.equal(rows(f).length, 0)
  assert.equal(result.confirmTracking().data.id, 41)
})

test('延后确认遇账号切换/取消/身份不可读保持原记录', async () => {
  for (const mode of ['changed', 'denied', 'abort']) {
    let current = true, denied = false; const controller = new AbortController(), f = fixture(async () => response)
    const result = await f.creator.create(body, { ...f.options, deferCleanup: true, signal: controller.signal,
      isCurrent: () => { if (denied) throw Error('denied'); return current } })
    const raw = rows(f)[0][1]
    if (mode === 'changed') current = false; if (mode === 'denied') denied = true; if (mode === 'abort') controller.abort()
    assert.throws(result.confirmTracking, e => e.name === 'AbortError'); assert.equal(rows(f)[0][1], raw)
  }
})

test('清理读取/删除失败或原槽改动返回已确认warning，不覆盖任何新槽', async () => {
  for (const mode of ['read', 'remove', 'changed', 'missing']) {
    const f = fixture(async () => response), result = await f.creator.create(body, { ...f.options, deferCleanup: true })
    const [key, raw] = rows(f)[0]
    if (mode === 'read') f.storage.getItem = () => { throw Error('denied') }
    if (mode === 'remove') f.storage.removeItem = () => { throw Error('denied') }
    if (mode === 'changed') f.values.set(key, '{new record')
    if (mode === 'missing') f.values.delete(key)
    const confirmed = result.confirmTracking()
    assert.equal(confirmed.data.id, 41); assert.ok(confirmed.creationTrackingWarning)
    assert.equal(f.values.get(key) ?? null, mode === 'missing' ? null : mode === 'changed' ? '{new record' : raw)
  }
})

test('非法字段/输入/身份/crypto不发送，不存正文、凭据或无效原请求', async () => {
  let calls = 0; const f = fixture(async () => { calls++; return response })
  for (const input of [null, [], {}, { name: '有效' }, { ...body, token: 'secret' }, { ...body, content: '正文' },
    { ...body, name: '' }, { ...body, name: ' ' }, { ...body, name: '名'.repeat(81) }, { ...body, name: '名\t称' },
    { ...body, description: null }, { ...body, description: '介'.repeat(301) }, { ...body, description: '简\t介' }]) {
    await assert.rejects(f.creator.create(input, f.options), e => e.reason === 'GROUP_CREATION_INPUT')
  }
  for (const options of [{ ...f.options, account: '' }, { ...f.options, service: '' }, { ...f.options, isCurrent: null },
    { ...f.options, deferCleanup: 'true' }, { ...f.options, onPrepared: 1 }]) {
    await assert.rejects(f.creator.create(body, options), e => e.reason === 'GROUP_CREATION_IDENTITY')
  }
  await assert.rejects(createGroupCreator({ ...f.dependencies, crypto: {} }).create(body, f.options), e => e.reason === 'GROUP_CREATION_CRYPTO')
  await assert.rejects(createGroupCreator({ ...f.dependencies, crypto: { subtle: webcrypto.subtle,
    randomUUID: () => { throw Error('entropy failed') } } }).create(body, f.options), e => e.reason === 'GROUP_CREATION_CRYPTO')
  assert.equal(calls, 0); assert.equal(rows(f).length, 0)
})
