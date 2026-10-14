import test from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { createCopyCreator } from './copyCreation.js'
import { createDocumentCreator, documentCreationTrackingKey } from './creationRequest.js'

const body = { title: '原副本😀' }
const response = { data: { id: 41, title: '原副本😀', sourceRevision: 1 } }
const lost = async () => { throw Error('lost reply') }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function fixture(post = lost) {
  const values = new Map([['copage-draft:v1:owner:26:tab', '原草稿']]), reads = [], removes = []
  let sequence = 0
  const storage = { get length() { return values.size }, key: index => [...values.keys()][index] ?? null,
    getItem: key => { reads.push(key); return values.get(key) ?? null },
    setItem: (key, value) => values.set(key, value), removeItem: key => { removes.push(key); values.delete(key) } }
  const crypto = { subtle: webcrypto.subtle, randomUUID: () => '00000000-0000-4000-8000-' + String(++sequence).padStart(12, '0') }
  const dependencies = { getStorage: () => storage, crypto, post }
  return { values, reads, removes, storage, crypto, dependencies, creator: createCopyCreator(dependencies),
    reload: () => createCopyCreator(dependencies), options: { account: 'owner', service: '/api' } }
}
const rows = f => [...f.values].filter(([key]) => key.startsWith('copage-copy-create:'))
const legacyKey = (f, input = body) => documentCreationTrackingKey(f.crypto, { ...f.options, path: '/doc/12/copy', body: input })

test('共用指纹与旧创建真实槽完全兼容，迁移旧UUID后丢回复重载仍确认同一副本', async () => {
  const f = fixture(), requests = [], receipts = new Map()
  const key = await legacyKey(f)
  const old = createDocumentCreator({ ...f.dependencies, post: async (_, input, config) => {
    const uuid = config.headers['Idempotency-Key']; receipts.set(uuid, response); throw Error('lost')
  } })
  await assert.rejects(old('/doc/12/copy', body, f.options))
  const oldUUID = f.values.get(key)
  assert.match(oldUUID, /^[\da-f-]{36}$/)
  f.dependencies.post = async (path, input, config) => { requests.push({ path, input, uuid: config.headers['Idempotency-Key'] }); return receipts.get(config.headers['Idempotency-Key']) }
  const creator = f.reload()
  const result = await creator.create(12, body, { ...f.options, deferCleanup: true })
  assert.equal(result.data.id, 41); assert.equal(f.values.get(key), oldUUID)
  const [primary, raw] = rows(f)[0]
  assert.equal(JSON.parse(raw).legacyRaw, oldUUID); assert.equal(primary.split(':').at(-1), key.split(':').at(-1))
  const reloaded = f.reload(), record = (await reloaded.listPending(f.options))[0]
  const confirmed = await reloaded.retry(record, f.options)
  assert.equal(confirmed.data.id, 41); assert.equal(receipts.size, 1)
  assert.deepEqual(requests.map(r => r.uuid), [oldUUID, oldUUID])
  assert.deepEqual(f.removes, [key, primary]); assert.equal(rows(f).length, 0)
  assert.equal(f.values.get('copage-draft:v1:owner:26:tab'), '原草稿')
})

test('已提交原副本在来源失效后仍确认，未提交且来源失效不新建；400/401/403/404都保留原UUID', async () => {
  for (const committed of [true, false]) {
    const receipts = new Map(), ids = []; let sourceValid = true, first = true
    const f = fixture(async (_, input, config) => {
      const uuid = config.headers['Idempotency-Key']; ids.push(uuid)
      if (receipts.has(uuid)) return receipts.get(uuid)
      if (!sourceValid) throw { code: 404 }
      if (first) { first = false; if (committed) receipts.set(uuid, response); throw Error('lost') }
      assert.fail('不应发起新副本')
    })
    await assert.rejects(f.creator.create(12, body, f.options))
    sourceValid = false
    const reload = f.reload(), row = (await reload.listPending(f.options))[0]
    if (committed) assert.equal((await reload.retry(row, f.options)).data.id, 41)
    else { await assert.rejects(reload.retry(row, f.options), e => e.code === 404); assert.equal(rows(f).length, 1) }
    assert.equal(new Set(ids).size, 1); assert.equal(receipts.size, committed ? 1 : 0)
  }
  for (const code of [400, 401, 403, 404, 503]) {
    const ids = [], f = fixture(async (_, __, config) => { ids.push(config.headers['Idempotency-Key']); throw { code } })
    await assert.rejects(f.creator.create(12, body, f.options))
    const row = (await f.creator.listPending(f.options))[0]
    await assert.rejects(f.creator.retry(row, f.options), e => e.code === code)
    assert.equal(rows(f).length, 1); assert.equal(ids[0], ids[1])
  }
})

test('同内容未知仍同UUID，确认成功后同内容主动创建使用新UUID，默认标题与显式标题保持区别', async () => {
  const requests = [], receipts = new Map(); let lose = true
  const f = fixture(async (_, input, config) => {
    const uuid = config.headers['Idempotency-Key']; requests.push({ uuid, input })
    if (!receipts.has(uuid)) receipts.set(uuid, { data: { ...response.data, id: 41 + receipts.size } })
    if (lose) throw Error('lost'); return receipts.get(uuid)
  })
  await assert.rejects(f.creator.create(12, {}, f.options))
  await assert.rejects(f.creator.create(12, {}, f.options))
  await assert.rejects(f.creator.create(12, { title: '原标题 的副本' }, f.options))
  assert.equal(requests[0].uuid, requests[1].uuid); assert.notEqual(requests[1].uuid, requests[2].uuid)
  assert.deepEqual(requests[0].input, {}); assert.equal(rows(f).length, 2)
  lose = false
  assert.equal((await f.creator.create(12, {}, f.options)).data.id, 41)
  assert.equal((await f.creator.create(12, {}, f.options)).data.id, 43)
  assert.notEqual(requests[3].uuid, requests[4].uuid)
})

test('输入在首个await前冻结；同标签并行准备不会覆盖原UUID', async () => {
  const requests = [], f = fixture(async (_, input, config) => { requests.push({ input, uuid: config.headers['Idempotency-Key'] }); throw Error('lost') })
  const mutable = { ...body }, attempt = f.creator.create(12, mutable, f.options)
  mutable.title = '新标题'
  await assert.rejects(attempt)
  await Promise.allSettled([f.creator.create(12, body, f.options), f.creator.create(12, body, f.options)])
  assert.deepEqual(requests.map(r => r.input), [body, body, body]); assert.equal(new Set(requests.map(r => r.uuid)).size, 1)
  assert.equal(rows(f).length, 1)
})

test('迁移非法旧UUID不发送、不改槽、不生成替代记录', async () => {
  let calls = 0; const f = fixture(async () => { calls++; return response }), key = await legacyKey(f)
  for (const raw of ['', 'bad', JSON.stringify({ requestId: f.crypto.randomUUID() })]) {
    f.values.set(key, raw)
    await assert.rejects(f.creator.create(12, body, f.options), e => e.reason === 'COPY_CREATION_RECORD')
    assert.equal(f.values.get(key), raw); assert.equal(rows(f).length, 0)
  }
  assert.equal(calls, 0)
})

test('准备getStorage/getItem/setItem异常不发送；迁移写失败保留旧UUID', async () => {
  for (const method of ['getStorage', 'getItem', 'setItem']) {
    let calls = 0; const f = fixture(async () => { calls++; return response }), key = await legacyKey(f), uuid = f.crypto.randomUUID()
    f.values.set(key, uuid)
    if (method === 'getStorage') f.dependencies.getStorage = () => { throw Error('blocked') }
    else f.storage[method] = () => { throw Error('blocked') }
    await assert.rejects(f.reload().create(12, body, f.options), e => e.reason === 'COPY_CREATION_STORAGE')
    assert.equal(calls, 0); assert.equal(f.values.get(key), uuid); assert.equal(rows(f).length, 0)
  }
})

test('账号/服务/不同来源严格隔离，扫描不读取其它namespace；跨域摘要与伪造摘要拒绝', async () => {
  const f = fixture(), variants = [f.options, { ...f.options, account: 'owner:😀%' }, { ...f.options, service: 'https://example/api:%' }]
  for (const options of variants) await assert.rejects(f.creator.create(12, body, options))
  await assert.rejects(f.creator.create(13, body, f.options))
  f.reads.length = 0
  const pending = await f.creator.listPending(f.options)
  assert.deepEqual(pending.map(r => r.sourceId).sort(), [12, 13])
  assert.ok(f.reads.every(key => pending.some(row => row.key === key)))
  assert.ok(pending.every(row => Object.isFrozen(row) && Object.isFrozen(row.body)))
  const count = f.reads.length
  await assert.rejects(f.creator.retry(pending[0], variants[1]), e => e.reason === 'COPY_CREATION_RECORD')
  await assert.rejects(f.creator.retry(pending[0], variants[2]), e => e.reason === 'COPY_CREATION_RECORD')
  await assert.rejects(f.creator.retry({ ...pending[0] }, f.options), e => e.reason === 'COPY_CREATION_RECORD')
  assert.equal(f.reads.length, count)
})

test('retry原槽消失、改UUID、改来源/标题或损坏不发送，原raw不覆盖', async () => {
  let calls = 0; const f = fixture(async () => { calls++; throw Error('lost') })
  await assert.rejects(f.creator.create(12, body, f.options))
  const row = (await f.creator.listPending(f.options))[0], raw = f.values.get(row.key), parsed = JSON.parse(raw)
  for (const changed of [null, '{bad', JSON.stringify({ ...parsed, requestId: f.crypto.randomUUID() }),
    JSON.stringify({ ...parsed, sourceId: 13 }), JSON.stringify({ ...parsed, body: { title: '改标题' } })]) {
    if (changed === null) f.values.delete(row.key); else f.values.set(row.key, changed)
    await assert.rejects(f.creator.retry(row, f.options), e => e.reason === 'COPY_CREATION_CHANGED')
    assert.equal(f.values.get(row.key) ?? null, changed)
  }
  assert.equal(calls, 1)
})

test('扫描为空与失败区分：读取/key/length故障或坏记录不返回部分清单', async () => {
  const f = fixture(); assert.deepEqual(await f.creator.listPending(f.options), [])
  await assert.rejects(f.creator.create(12, body, f.options)); await assert.rejects(f.creator.create(13, body, f.options))
  const keyMethod = f.storage.key
  f.storage.key = () => { throw Error('denied') }
  await assert.rejects(f.creator.listPending(f.options), e => e.reason === 'COPY_CREATION_STORAGE')
  f.storage.key = keyMethod
  const [key] = rows(f)[1]; f.values.set(key, '{broken')
  await assert.rejects(f.creator.listPending(f.options), e => e.reason === 'COPY_CREATION_RECORD')
  assert.equal(f.values.get(key), '{broken')
  Object.defineProperty(f.storage, 'length', { get: () => -1 })
  await assert.rejects(f.creator.listPending(f.options), e => e.reason === 'COPY_CREATION_STORAGE')
})

test('记录字段/UUID/编号/时间/大小/标题及指纹严格验证，损坏原raw保留', async () => {
  const f = fixture(); await assert.rejects(f.creator.create(12, body, f.options))
  const [key, raw] = rows(f)[0], record = JSON.parse(raw)
  const broken = [{ ...record, version: 2 }, { ...record, requestId: 'bad' }, { ...record, sourceId: 0 },
    { ...record, sourceId: Number.MAX_SAFE_INTEGER + 1 }, { ...record, createdAt: 0 },
    { ...record, createdAt: Date.now() + 100000 }, { ...record, token: 'forbidden' },
    { ...record, legacyRaw: f.crypto.randomUUID() }, { ...record, body: { title: undefined } },
    { ...record, body: { title: '名'.repeat(201) } }, { ...record, body: { title: '改标题' } },
    { ...record, body: { title: '有效', content: '正文不可存' } }]
  delete broken[0].sourceId
  for (const item of broken) {
    const changed = JSON.stringify(item); f.values.set(key, changed)
    await assert.rejects(f.creator.listPending(f.options), e => e.reason === 'COPY_CREATION_RECORD')
    await assert.rejects(f.creator.create(12, body, f.options), e => e.reason === 'COPY_CREATION_RECORD')
    assert.equal(f.values.get(key), changed)
  }
  f.values.set(key, raw + ' '.repeat(4096))
  await assert.rejects(f.creator.listPending(f.options), e => e.reason === 'COPY_CREATION_RECORD')
  f.values.delete(key); const wrongKey = key.slice(0, -1) + (key.endsWith('0') ? '1' : '0'); f.values.set(wrongKey, raw)
  await assert.rejects(f.creator.listPending(f.options), e => e.reason === 'COPY_CREATION_RECORD')
})

test('onPrepared在存妥后传递冻结摘要，retry保持原对象引用，内部options不传axios', async () => {
  let prepared, receive; const f = fixture(async (path, input, config) => {
    assert.equal(path, '/doc/12/copy'); assert.deepEqual(input, body)
    assert.equal(JSON.parse(f.values.get(prepared.key)).requestId, prepared.requestId)
    assert.equal(config.headers['Idempotency-Key'], prepared.requestId)
    assert.equal(config.headers.Custom, 'yes'); assert.equal(config.timeout, 12); assert.equal(config.copageExpectedSessionToken, 'captured-token')
    for (const option of ['account', 'service', 'isCurrent', 'onPrepared', 'deferCleanup']) assert.equal(Object.hasOwn(config, option), false)
    return response
  })
  const options = { ...f.options, deferCleanup: true, onPrepared: summary => { prepared = summary }, timeout: 12,
    copageExpectedSessionToken: 'captured-token', headers: { Custom: 'yes', 'Idempotency-Key': 'cannot-override' } }
  await f.creator.create(12, body, options)
  const row = (await f.creator.listPending(f.options))[0]
  await f.creator.retry(row, { ...options, onPrepared: summary => { prepared = summary; receive = summary } })
  assert.equal(receive, row); assert.equal(Object.isFrozen(row.body), true)
})

test('onPrepared拒绝/改槽/取消/身份不可读时不发请求，原记录保留', async () => {
  for (const mode of ['throw', 'changed', 'abort', 'identity']) {
    let calls = 0, current = true; const controller = new AbortController(), f = fixture(async () => { calls++; return response })
    await assert.rejects(f.creator.create(12, body, { ...f.options, signal: controller.signal,
      isCurrent: () => { if (!current) throw Error('identity'); return true },
      onPrepared: row => { if (mode === 'throw') throw Error('callback'); if (mode === 'changed') f.values.set(row.key, '{changed')
        if (mode === 'abort') controller.abort(); if (mode === 'identity') current = false } }))
    assert.equal(calls, 0); assert.equal(rows(f).length, 1)
  }
})

test('取消、身份切换或不可读后的迟到200不清原记录，下次原账号重登仍同UUID', async () => {
  for (const mode of ['abort', 'identity', 'denied']) {
    const wait = deferred(), started = deferred(); let current = true, denied = false
    const f = fixture(() => { started.resolve(); return wait.promise }), controller = new AbortController()
    const promise = f.creator.create(12, body, { ...f.options, signal: controller.signal,
      isCurrent: () => { if (denied) throw Error('identity'); return current } })
    await started.promise
    const raw = rows(f)[0][1]
    if (mode === 'abort') controller.abort(); if (mode === 'identity') current = false; if (mode === 'denied') denied = true
    wait.resolve(response)
    await assert.rejects(promise, e => e.name === 'AbortError')
    assert.equal(rows(f)[0][1], raw)
    const reload = f.reload(), row = (await reload.listPending(f.options))[0]
    assert.equal(row.requestId, JSON.parse(raw).requestId)
    await reload.retry(row, f.options)
  }
})

test('扫描身份前后守卫，不返回旧账号摘要或先读旧账号槽；已取消不准备', async () => {
  const f = fixture(); await assert.rejects(f.creator.create(12, body, f.options))
  let current = true; const key = f.storage.key
  f.storage.key = index => { current = false; return key(index) }
  await assert.rejects(f.creator.listPending({ ...f.options, isCurrent: () => current }), e => e.name === 'AbortError')
  f.storage.key = key; f.reads.length = 0
  await assert.rejects(f.creator.listPending({ ...f.options, isCurrent: () => { throw Error('denied') } }), e => e.name === 'AbortError')
  assert.equal(f.reads.length, 0)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(f.creator.create(12, body, { ...f.options, signal: controller.signal }), e => e.name === 'AbortError')
})

test('坏200必须保留UUID：id/title/sourceRevision严格校验，重载后仍确认一份原副本', async () => {
  for (const data of [null, {}, { ...response.data, id: 0 }, { ...response.data, id: '41' },
    { ...response.data, id: Number.MAX_SAFE_INTEGER + 1 }, { ...response.data, title: null },
    { ...response.data, sourceRevision: -1 }, { ...response.data, sourceRevision: 1.5 },
    { ...response.data, sourceRevision: '1' }]) {
    const ids = [], receipts = new Map(); let bad = true
    const f = fixture(async (_, __, config) => {
      const uuid = config.headers['Idempotency-Key']; ids.push(uuid); receipts.set(uuid, response)
      return bad ? { data } : receipts.get(uuid)
    })
    await assert.rejects(f.creator.create(12, body, f.options), e => e.reason === 'COPY_CREATION_RESPONSE')
    bad = false
    const reload = f.reload(), row = (await reload.listPending(f.options))[0]
    assert.equal((await reload.retry(row, f.options)).data.id, 41)
    assert.equal(new Set(ids).size, 1); assert.equal(receipts.size, 1)
  }
  const f = fixture(async () => ({ data: { id: 41, title: '副本', sourceRevision: 0 } }))
  assert.equal((await f.creator.create(12, {}, f.options)).data.sourceRevision, 0)
})

test('deferCleanup最终caller拒绝身份时保留记录，确认函数同步且清理后无额外身份读取', async () => {
  let fail = false; const f = fixture(async () => response)
  const result = await f.creator.create(12, body, { ...f.options, deferCleanup: true,
    isCurrent: () => { if (fail) throw Error('identity'); return true } })
  assert.equal(rows(f).length, 1)
  const accept = () => { throw Error('caller cannot verify identity') }
  assert.throws(accept); assert.equal(rows(f).length, 1)
  const remove = f.storage.removeItem; f.storage.removeItem = key => { remove(key); fail = true }
  const confirmed = result.confirmTracking()
  assert.equal(confirmed instanceof Promise, false); assert.equal(confirmed.data.id, 41); assert.equal(rows(f).length, 0)
})

test('延后确认换账号/取消/身份不可读均不清记录', async () => {
  for (const mode of ['changed', 'denied', 'abort']) {
    let current = true, denied = false; const controller = new AbortController(), f = fixture(async () => response)
    const result = await f.creator.create(12, body, { ...f.options, deferCleanup: true, signal: controller.signal,
      isCurrent: () => { if (denied) throw Error('denied'); return current } })
    const raw = rows(f)[0][1]
    if (mode === 'changed') current = false; if (mode === 'denied') denied = true; if (mode === 'abort') controller.abort()
    assert.throws(result.confirmTracking, e => e.name === 'AbortError'); assert.equal(rows(f)[0][1], raw)
  }
})

test('清理读取/删除失败返回成功warning；primary改槽不覆盖新记录', async () => {
  for (const mode of ['read', 'remove', 'changed']) {
    const f = fixture(async () => response), result = await f.creator.create(12, body, { ...f.options, deferCleanup: true })
    const [key, raw] = rows(f)[0], remove = f.storage.removeItem
    if (mode === 'read') f.storage.getItem = () => { throw Error('denied') }
    if (mode === 'remove') f.storage.removeItem = () => { throw Error('denied') }
    if (mode === 'changed') f.values.set(key, '{new record')
    const confirmed = result.confirmTracking()
    assert.equal(confirmed.data.id, 41); assert.ok(confirmed.creationTrackingWarning)
    assert.equal(f.values.get(key), mode === 'changed' ? '{new record' : raw)
    f.storage.removeItem = remove
  }
})

test('legacy先清primary后清；旧槽变化不覆盖；部分清理失败仍可重载原UUID确认', async () => {
  for (const mode of ['legacyChanged', 'legacyRemove', 'primaryRemove']) {
    const f = fixture(async () => response), key = await legacyKey(f), uuid = f.crypto.randomUUID()
    f.values.set(key, uuid)
    const result = await f.creator.create(12, body, { ...f.options, deferCleanup: true }), [primary] = rows(f)[0]
    const remove = f.storage.removeItem
    if (mode === 'legacyChanged') f.values.set(key, '11111111-1111-4111-8111-111111111111')
    else f.storage.removeItem = slot => { if (slot === (mode === 'legacyRemove' ? key : primary)) throw Error('denied'); remove(slot) }
    assert.ok(result.confirmTracking().creationTrackingWarning); assert.equal(rows(f).length, 1)
    if (mode === 'primaryRemove') assert.equal(f.values.has(key), false)
    else assert.equal(f.values.has(key), true)
    if (mode === 'legacyChanged') { assert.equal(f.removes.length, 0); continue }
    f.storage.removeItem = remove
    const reload = f.reload(), row = (await reload.listPending(f.options))[0]
    assert.equal(row.requestId, uuid); assert.equal((await reload.retry(row, f.options)).data.id, 41)
    assert.equal(rows(f).length, 0); assert.equal(f.values.has(key), false)
  }
})

test('非法输入/身份/crypto不发送、不写正文或凭据', async () => {
  let calls = 0; const f = fixture(async () => { calls++; return response })
  for (const sourceId of [0, -1, '12', 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(f.creator.create(sourceId, body, f.options), e => e.reason === 'COPY_CREATION_INPUT')
  }
  for (const input of [null, [], { title: undefined }, { title: '' }, { title: ' ' }, { title: '名'.repeat(201) },
    { ...body, content: '正文' }, { ...body, token: 'secret' }]) {
    await assert.rejects(f.creator.create(12, input, f.options), e => e.reason === 'COPY_CREATION_INPUT')
  }
  await assert.rejects(f.creator.create(12, body, { ...f.options, account: '' }), e => e.reason === 'COPY_CREATION_IDENTITY')
  await assert.rejects(createCopyCreator({ ...f.dependencies, crypto: {} }).create(12, body, f.options), e => e.reason === 'COPY_CREATION_CRYPTO')
  assert.equal(calls, 0); assert.equal(rows(f).length, 0)
})
