import test from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { createProjectDocumentCreator } from './projectDocumentCreation.js'

const input = { projectId: 31, projectName: ' 原项目😀 ', title: ' 原标题😀 ', templateId: null }
const response = { data: { id: 541, projectId: 31, title: '原标题😀' } }
const lost = async () => { throw Error('lost reply') }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function fixture(post = lost) {
  const values = new Map([['copage-draft:v1:owner:26:tab', '原草稿'], ['copage-group-create:v1:other', '原小组记录']])
  const reads = [], removes = []; let sequence = 0
  const storage = { get length() { return values.size }, key: index => [...values.keys()][index] ?? null,
    getItem: key => { reads.push(key); return values.get(key) ?? null },
    setItem: (key, value) => values.set(key, value), removeItem: key => { removes.push(key); values.delete(key) } }
  const crypto = { subtle: webcrypto.subtle, randomUUID: () => '00000000-0000-4000-8000-' + String(++sequence).padStart(12, '0') }
  const dependencies = { getStorage: () => storage, crypto, post }
  return { values, reads, removes, storage, crypto, dependencies, creator: createProjectDocumentCreator(dependencies),
    reload: () => createProjectDocumentCreator(dependencies), options: { account: 'owner', service: '/api' } }
}
const rows = f => [...f.values].filter(([key]) => key.startsWith('copage-project-document:'))

test('已提交但丢回复：项目归档/退组/文档软删后重挂只确认原事务，不重新创建或关联', async () => {
  for (const templateId of [null, 'weekly']) {
    const receipts = new Map(), requests = []; let archived = false, member = true, deleted = false, associations = 0
    const f = fixture(async (path, body, config) => {
      const uuid = config.headers['Idempotency-Key']; requests.push({ path, body, uuid })
      if (receipts.has(uuid)) return receipts.get(uuid)
      assert.equal(archived, false); assert.equal(member, true); assert.equal(deleted, false)
      receipts.set(uuid, response); associations++; throw Error('lost after commit')
    })
    await assert.rejects(f.creator.create({ ...input, templateId }, f.options))
    archived = true; member = false; deleted = true; associations = 0
    const reload = f.reload(), row = (await reload.listPending(f.options))[0]
    assert.equal((await reload.retry(row, f.options)).data.id, 541)
    assert.equal(associations, 0); assert.equal(receipts.size, 1); assert.equal(rows(f).length, 0)
    assert.deepEqual(requests.map(r => r.path), ['/projects/31/documents/new', '/projects/31/documents/new'])
    assert.deepEqual(requests[1].body, { title: input.title, templateId }); assert.equal(requests[1].uuid, requests[0].uuid)
    assert.equal(f.values.get('copage-draft:v1:owner:26:tab'), '原草稿')
    assert.equal(f.values.get('copage-group-create:v1:other'), '原小组记录')
  }
})

test('未送达后确认可首次完成原事务，成功后同资料主动创建使用新UUID', async () => {
  const requests = [], receipts = new Map(); let disconnected = true
  const f = fixture(async (_, body, config) => {
    const uuid = config.headers['Idempotency-Key']; requests.push(uuid)
    if (disconnected) throw Error('not delivered')
    if (!receipts.has(uuid)) receipts.set(uuid, { data: { ...response.data, id: 541 + receipts.size } })
    return receipts.get(uuid)
  })
  await assert.rejects(f.creator.create(input, f.options))
  disconnected = false
  const reload = f.reload(), row = (await reload.listPending(f.options))[0]
  assert.equal((await reload.retry(row, f.options)).data.id, 541)
  assert.equal((await reload.create(input, f.options)).data.id, 542)
  assert.equal(requests[0], requests[1]); assert.notEqual(requests[1], requests[2]); assert.equal(receipts.size, 2)
})

test('项目不同、空白与模板不同、原字符串不同各自隔离；只改本地项目标签沿用旧请求', async () => {
  const calls = [], f = fixture(async (path, body, config) => { calls.push({ path, body, uuid: config.headers['Idempotency-Key'] }); throw Error('lost') })
  for (const value of [input, { ...input, projectId: 32 }, { ...input, templateId: 'weekly' },
    { ...input, title: input.title.trim() }, { ...input, projectName: '项目已改名' }]) {
    await assert.rejects(f.creator.create(value, f.options))
  }
  assert.equal(rows(f).length, 4); assert.equal(new Set(calls.map(r => r.uuid)).size, 4)
  assert.equal(calls[0].uuid, calls[4].uuid)
  const row = (await f.creator.listPending(f.options)).find(r => r.requestId === calls[0].uuid)
  assert.equal(row.projectName, input.projectName)
  assert.deepEqual(calls[0].body, { title: input.title, templateId: null })
  assert.equal(Object.hasOwn(calls[0].body, 'projectName'), false)
})

test('首个await前冻结原输入，合法模板原空白不重写；同标签并行重试不覆盖UUID', async () => {
  const calls = [], f = fixture(async (_, body, config) => { calls.push({ body, uuid: config.headers['Idempotency-Key'] }); throw Error('lost') })
  const original = { ...input, templateId: ' weekly ' }, mutable = { ...original }
  const attempt = f.creator.create(mutable, f.options)
  mutable.projectId = 32; mutable.projectName = '改名'; mutable.title = '修改'; mutable.templateId = null
  await assert.rejects(attempt)
  await Promise.allSettled([f.creator.create(original, f.options), f.creator.create(original, f.options)])
  assert.deepEqual(calls.map(r => r.body), Array(3).fill({ title: input.title, templateId: ' weekly ' }))
  assert.equal(new Set(calls.map(r => r.uuid)).size, 1)
  const row = (await f.creator.listPending(f.options))[0]
  assert.equal(Object.isFrozen(row), true); assert.equal(Object.isFrozen(row.body), true)
})

test('失败码、拒绝和取消不清原槽，不按列表或当前项目访问情况猜测完成', async () => {
  for (const code of [400, 401, 403, 404, 409, 503]) {
    const ids = [], f = fixture(async (_, __, config) => { ids.push(config.headers['Idempotency-Key']); throw { code } })
    await assert.rejects(f.creator.create(input, f.options))
    const row = (await f.creator.listPending(f.options))[0], raw = f.values.get(row.key)
    await assert.rejects(f.creator.retry(row, f.options), e => e.code === code)
    assert.equal(f.values.get(row.key), raw); assert.equal(ids[0], ids[1])
  }
})

test('不同账号/服务只能枚举自身槽；伪造、跨账号及跨实例摘要不发送', async () => {
  const f = fixture(), variants = [f.options, { ...f.options, account: 'other:😀%' }, { ...f.options, service: 'https://other/api:%' }]
  for (const options of variants) await assert.rejects(f.creator.create(input, options))
  f.reads.length = 0
  const row = (await f.creator.listPending(f.options))[0]
  assert.equal(f.reads.every(key => key === row.key), true)
  const count = f.reads.length
  for (const options of variants.slice(1)) await assert.rejects(f.creator.retry(row, options), e => e.reason === 'PROJECT_DOCUMENT_CREATION_RECORD')
  await assert.rejects(f.creator.retry({ ...row }, f.options), e => e.reason === 'PROJECT_DOCUMENT_CREATION_RECORD')
  await assert.rejects(f.reload().retry(row, f.options), e => e.reason === 'PROJECT_DOCUMENT_CREATION_RECORD')
  assert.equal(f.reads.length, count)
})

test('原槽删除、改UUID或改标签/项目/body均拒绝旧摘要，不覆盖变化或发送替代', async () => {
  let calls = 0; const f = fixture(async () => { calls++; throw Error('lost') })
  await assert.rejects(f.creator.create(input, f.options))
  const row = (await f.creator.listPending(f.options))[0], parsed = JSON.parse(f.values.get(row.key))
  for (const changed of [null, '{bad', JSON.stringify({ ...parsed, requestId: f.crypto.randomUUID() }),
    JSON.stringify({ ...parsed, projectId: 32 }), JSON.stringify({ ...parsed, projectName: '改标签' }),
    JSON.stringify({ ...parsed, title: '改标题' }), JSON.stringify({ ...parsed, templateId: 'weekly' })]) {
    if (changed === null) f.values.delete(row.key); else f.values.set(row.key, changed)
    await assert.rejects(f.creator.retry(row, f.options), e => e.reason === 'PROJECT_DOCUMENT_CREATION_CHANGED')
    assert.equal(f.values.get(row.key) ?? null, changed)
  }
  assert.equal(calls, 1)
})

test('准备回调在存妥后收到原冻结摘要，内部options不泄入HTTP；拒绝或改槽时POST0', async () => {
  let prepared; const f = fixture(async (path, body, config) => {
    assert.equal(path, '/projects/31/documents/new'); assert.deepEqual(body, prepared.body)
    assert.equal(JSON.parse(f.values.get(prepared.key)).requestId, config.headers['Idempotency-Key'])
    assert.equal(config.headers.Custom, 'yes'); assert.equal(config.timeout, 12); assert.equal(config.copageExpectedSessionToken, 'captured')
    for (const key of ['account', 'service', 'isCurrent', 'onPrepared', 'deferCleanup']) assert.equal(Object.hasOwn(config, key), false)
    return response
  })
  await f.creator.create(input, { ...f.options, onPrepared: row => { prepared = row }, deferCleanup: true, timeout: 12,
    copageExpectedSessionToken: 'captured', headers: { Custom: 'yes', 'Idempotency-Key': 'wrong' } })
  for (const mode of ['throw', 'changed', 'abort', 'identity']) {
    let calls = 0, current = true; const controller = new AbortController(), g = fixture(async () => { calls++; return response })
    await assert.rejects(g.creator.create(input, { ...g.options, signal: controller.signal, isCurrent: () => current,
      onPrepared: row => { if (mode === 'throw') throw Error('callback'); if (mode === 'changed') g.values.set(row.key, '{changed')
        if (mode === 'abort') controller.abort(); if (mode === 'identity') current = false } }))
    assert.equal(calls, 0); assert.equal(rows(g).length, 1)
  }
})

test('取消、切账号或身份不可读后的迟到200保留原记录，重挂仍可确认原UUID', async () => {
  for (const mode of ['abort', 'changed', 'denied']) {
    const wait = deferred(), started = deferred(); let current = true, denied = false
    const f = fixture(() => { started.resolve(); return wait.promise }), controller = new AbortController()
    const promise = f.creator.create(input, { ...f.options, signal: controller.signal,
      isCurrent: () => { if (denied) throw Error('denied'); return current } })
    await started.promise
    const raw = rows(f)[0][1]
    if (mode === 'abort') controller.abort(); if (mode === 'changed') current = false; if (mode === 'denied') denied = true
    wait.resolve(response)
    await assert.rejects(promise, e => e.name === 'AbortError'); assert.equal(rows(f)[0][1], raw)
    const reload = f.reload(), row = (await reload.listPending(f.options))[0]
    assert.equal(row.requestId, JSON.parse(raw).requestId); assert.equal((await reload.retry(row, f.options)).data.id, 541)
  }
})

test('坏200的id/原projectId/title必须严格校验，未知保留后同UUID确认', async () => {
  for (const data of [null, {}, { ...response.data, id: 0 }, { ...response.data, id: '541' },
    { ...response.data, id: Number.MAX_SAFE_INTEGER + 1 }, { ...response.data, id: 1.5 },
    { ...response.data, projectId: '31' }, { ...response.data, projectId: 32 },
    { ...response.data, title: null }, { id: 541, projectId: 31 }]) {
    let bad = true; const ids = [], f = fixture(async (_, __, config) => { ids.push(config.headers['Idempotency-Key']); return bad ? { data } : response })
    await assert.rejects(f.creator.create(input, f.options), e => e.reason === 'PROJECT_DOCUMENT_CREATION_RESPONSE')
    bad = false
    const reload = f.reload(), row = (await reload.listPending(f.options))[0]
    assert.equal((await reload.retry(row, f.options)).data.id, 541); assert.equal(new Set(ids).size, 1)
  }
})

test('准备getStorage/getItem/setItem失败不发送；枚举读取故障不伪装没有待确认项', async () => {
  for (const method of ['getStorage', 'getItem', 'setItem']) {
    let calls = 0; const f = fixture(async () => { calls++; return response })
    if (method === 'getStorage') f.dependencies.getStorage = () => { throw Error('blocked') }
    else f.storage[method] = () => { throw Error('blocked') }
    await assert.rejects(f.reload().create(input, f.options), e => e.reason === 'PROJECT_DOCUMENT_CREATION_STORAGE')
    assert.equal(calls, 0); assert.equal(rows(f).length, 0)
  }
  const f = fixture(); assert.deepEqual(await f.creator.listPending(f.options), [])
  await assert.rejects(f.creator.create(input, f.options))
  const keyMethod = f.storage.key; f.storage.key = () => { throw Error('blocked') }
  await assert.rejects(f.creator.listPending(f.options), e => e.reason === 'PROJECT_DOCUMENT_CREATION_STORAGE')
  f.storage.key = keyMethod
  Object.defineProperty(f.storage, 'length', { get: () => -1 })
  await assert.rejects(f.creator.listPending(f.options), e => e.reason === 'PROJECT_DOCUMENT_CREATION_STORAGE')
})

test('损坏字段/大小/时间/UUID/项目标签或指纹保留原raw，不返回部分清单', async () => {
  const f = fixture(); await assert.rejects(f.creator.create(input, f.options))
  await assert.rejects(f.creator.create({ ...input, projectId: 32 }, f.options))
  const [key, raw] = rows(f)[0], parsed = JSON.parse(raw)
  const invalid = [{ ...parsed, version: 2 }, { ...parsed, requestId: 'bad' }, { ...parsed, projectName: '' },
    { ...parsed, projectName: '名'.repeat(81) }, { ...parsed, projectId: 32 }, { ...parsed, projectId: 0 },
    { ...parsed, title: '改标题' }, { ...parsed, templateId: '改模板' }, { ...parsed, createdAt: 0 },
    { ...parsed, createdAt: Date.now() + 100000 }, { ...parsed, token: 'forbidden' }, { ...parsed, templateId: '' }]
  delete invalid[0].templateId
  for (const item of invalid) {
    const changed = JSON.stringify(item); f.values.set(key, changed)
    await assert.rejects(f.creator.listPending(f.options), e => e.reason === 'PROJECT_DOCUMENT_CREATION_RECORD')
    await assert.rejects(f.creator.create(input, f.options), e => e.reason === 'PROJECT_DOCUMENT_CREATION_RECORD')
    assert.equal(f.values.get(key), changed)
  }
  f.values.set(key, raw + ' '.repeat(4096))
  await assert.rejects(f.creator.listPending(f.options), e => e.reason === 'PROJECT_DOCUMENT_CREATION_RECORD')
  f.values.delete(key); const wrong = key.slice(0, -1) + (key.endsWith('0') ? '1' : '0'); f.values.set(wrong, raw)
  await assert.rejects(f.creator.listPending(f.options), e => e.reason === 'PROJECT_DOCUMENT_CREATION_RECORD')
})

test('扫描中身份变化不返回旧摘要；取消或身份不可读时不读取旧账号槽', async () => {
  const f = fixture(); await assert.rejects(f.creator.create(input, f.options))
  let current = true; const keyMethod = f.storage.key
  f.storage.key = index => { current = false; return keyMethod(index) }
  await assert.rejects(f.creator.listPending({ ...f.options, isCurrent: () => current }), e => e.name === 'AbortError')
  f.storage.key = keyMethod; f.reads.length = 0
  await assert.rejects(f.creator.listPending({ ...f.options, isCurrent: () => { throw Error('denied') } }), e => e.name === 'AbortError')
  assert.equal(f.reads.length, 0)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(f.creator.create(input, { ...f.options, signal: controller.signal }), e => e.name === 'AbortError')
})

test('延后确认同步接受；清理后身份不可读不把成功倒推未知，重复确认仍成功', async () => {
  let fail = false; const f = fixture(async () => response)
  const result = await f.creator.create(input, { ...f.options, deferCleanup: true,
    isCurrent: () => { if (fail) throw Error('identity denied'); return true } })
  assert.equal(rows(f).length, 1)
  const remove = f.storage.removeItem; f.storage.removeItem = key => { remove(key); fail = true }
  const confirmed = result.confirmTracking()
  assert.equal(confirmed instanceof Promise, false); assert.equal(confirmed.data.id, 541); assert.equal(rows(f).length, 0)
  assert.equal(result.confirmTracking().data.id, 541)
})

test('延后确认换账号/取消/身份不可读不清记录；存储失败和改槽准确报告已确认warning', async () => {
  for (const mode of ['changedIdentity', 'deniedIdentity', 'abort']) {
    let current = true, denied = false; const controller = new AbortController(), f = fixture(async () => response)
    const result = await f.creator.create(input, { ...f.options, deferCleanup: true, signal: controller.signal,
      isCurrent: () => { if (denied) throw Error('denied'); return current } })
    const raw = rows(f)[0][1]
    if (mode === 'changedIdentity') current = false; if (mode === 'deniedIdentity') denied = true; if (mode === 'abort') controller.abort()
    assert.throws(result.confirmTracking, e => e.name === 'AbortError'); assert.equal(rows(f)[0][1], raw)
  }
  for (const mode of ['read', 'remove', 'changed', 'missing']) {
    const f = fixture(async () => response), result = await f.creator.create(input, { ...f.options, deferCleanup: true })
    const [key, raw] = rows(f)[0]
    if (mode === 'read') f.storage.getItem = () => { throw Error('denied') }
    if (mode === 'remove') f.storage.removeItem = () => { throw null }
    if (mode === 'changed') f.values.set(key, '{new record')
    if (mode === 'missing') f.values.delete(key)
    const confirmed = result.confirmTracking()
    assert.equal(confirmed.data.id, 541); assert.ok(confirmed.creationTrackingWarning)
    assert.equal(f.values.get(key) ?? null, mode === 'missing' ? null : mode === 'changed' ? '{new record' : raw)
  }
})

test('非法输入、缺字段、身份与crypto失败不发送，不写正文或凭据', async () => {
  let calls = 0; const f = fixture(async () => { calls++; return response })
  for (const value of [null, [], {}, { ...input, token: 'secret' }, { ...input, content: '正文' },
    { ...input, projectId: '31' }, { ...input, projectId: 0 }, { ...input, projectId: Number.MAX_SAFE_INTEGER + 1 },
    { ...input, projectName: ' ' }, { ...input, projectName: '名'.repeat(81) },
    { ...input, title: '' }, { ...input, title: ' ' }, { ...input, title: '标'.repeat(201) },
    { ...input, templateId: '' }, { ...input, templateId: ' ' }, { ...input, templateId: '模'.repeat(81) },
    { ...input, templateId: 1 }, { projectId: 31, projectName: '项目', title: '标题' }]) {
    await assert.rejects(f.creator.create(value, f.options), e => e.reason === 'PROJECT_DOCUMENT_CREATION_INPUT')
  }
  for (const options of [{ ...f.options, account: '' }, { ...f.options, service: '' }, { ...f.options, isCurrent: null },
    { ...f.options, deferCleanup: 'true' }, { ...f.options, onPrepared: 1 }]) {
    await assert.rejects(f.creator.create(input, options), e => e.reason === 'PROJECT_DOCUMENT_CREATION_IDENTITY')
  }
  await assert.rejects(createProjectDocumentCreator({ ...f.dependencies, crypto: {} }).create(input, f.options), e => e.reason === 'PROJECT_DOCUMENT_CREATION_CRYPTO')
  await assert.rejects(createProjectDocumentCreator({ ...f.dependencies, crypto: { subtle: webcrypto.subtle,
    randomUUID: () => { throw Error('entropy failed') } } }).create(input, f.options), e => e.reason === 'PROJECT_DOCUMENT_CREATION_CRYPTO')
  assert.equal(calls, 0); assert.equal(rows(f).length, 0)
})
