import test from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { createProjectCreator } from './projectCreation.js'
import { createProjectOperation } from './projectOperation.js'

const body = { name: '项目😀', description: '原简介\n第二行', groupId: 0 }
const lost = async () => { throw Error('committed but reply lost') }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function fixture(post = lost) {
  const values = new Map([['copage-draft:v1:owner:26:tab', '原草稿']]), reads = [], writes = []
  let sequence = 0
  const storage = { get length() { return values.size }, key: index => [...values.keys()][index] ?? null,
    getItem: key => { reads.push(key); return values.get(key) ?? null },
    setItem: (key, value) => { writes.push(key); values.set(key, value) }, removeItem: key => values.delete(key) }
  const crypto = { subtle: webcrypto.subtle, randomUUID: () => '00000000-0000-4000-8000-' + String(++sequence).padStart(12, '0') }
  const dependencies = { getStorage: () => storage, crypto, post }
  return { values, reads, writes, storage, crypto, dependencies, creator: createProjectCreator(dependencies),
    reload: () => createProjectCreator(dependencies), options: { account: 'owner', service: '/api' } }
}
const saved = f => [...f.values].filter(([key]) => key.startsWith('copage-project-create:'))

test('丢回复后重载由原摘要重试同UUID和完整原payload，确认后同内容主动创建用新UUID', async () => {
  const receipts = new Map(), requests = []; let lose = true
  const f = fixture(async (_, input, config) => {
    const id = config.headers['Idempotency-Key']; requests.push({ id, input })
    if (!receipts.has(id)) receipts.set(id, { data: { id: 41 + receipts.size, groupId: input.groupId } })
    if (lose) throw Error('lost')
    return receipts.get(id)
  })
  await assert.rejects(f.creator.create(body, f.options))
  const reload = f.reload(), records = await reload.listPending(f.options)
  assert.deepEqual(Object.keys(records[0]).sort(), ['createdAt', 'groupId', 'key', 'name', 'requestId'])
  assert.equal(JSON.stringify(records).includes(body.description), false)
  lose = false; assert.equal((await reload.retry(records[0], f.options)).data.id, 41)
  assert.equal((await reload.create(body, f.options)).data.id, 42)
  assert.deepEqual(requests.map(r => r.id), [records[0].requestId, records[0].requestId, requests[2].id])
  assert.notEqual(requests[1].id, requests[2].id)
  assert.equal(saved(f).length, 0); assert.equal(f.values.get('copage-draft:v1:owner:26:tab'), '原草稿')
})

test('同payload未确认再次准备仍沿用UUID，原输入在首个await前冻结且字段顺序不影响指纹', async () => {
  const requests = [], f = fixture(async (_, input, config) => { requests.push({ input, id: config.headers['Idempotency-Key'] }); throw Error('lost') })
  const input = { ...body }, promise = f.creator.create(input, f.options)
  input.name = '后来改名'; input.description = '后来简介'; input.groupId = 3
  await assert.rejects(promise)
  await assert.rejects(f.creator.create({ groupId: 0, description: body.description, name: ' 项目😀 ' }, f.options))
  assert.equal(requests[0].id, requests[1].id)
  assert.deepEqual(requests[0].input, body); assert.deepEqual(requests[1].input, body)
})

test('同标签并行准备相同payload不覆盖首个记录，两条请求沿用同UUID', async () => {
  const ids = [], f = fixture(async (_, __, config) => { ids.push(config.headers['Idempotency-Key']); throw Error('lost') })
  await Promise.allSettled([f.creator.create(body, f.options), f.creator.create(body, f.options)])
  assert.equal(ids.length, 2)
  assert.equal(new Set(ids).size, 1)
  assert.equal(JSON.parse(saved(f)[0][1]).requestId, ids[0])
})

test('401/403/404/400与未知故障均保留原记录，退组或归档不能证明首次创建未提交', async () => {
  for (const code of [401, 403, 404, 400, 503]) {
    const ids = [], f = fixture(async (_, __, config) => { ids.push(config.headers['Idempotency-Key']); throw { code } })
    await assert.rejects(f.creator.create(body, f.options))
    const record = (await f.creator.listPending(f.options))[0]
    await assert.rejects(f.creator.retry(record, f.options))
    assert.equal(saved(f).length, 1); assert.equal(ids[0], ids[1])
  }
})

test('准备getStorage/getItem/setItem失败不发送创建，原草稿和记录不删除', async () => {
  for (const method of ['getStorage', 'getItem', 'setItem']) {
    let calls = 0; const f = fixture(async () => { calls++; return { data: { id: 41, groupId: 0 } } })
    if (method === 'getStorage') f.dependencies.getStorage = () => { throw Error('denied') }
    else f.storage[method] = () => { throw Error('denied') }
    await assert.rejects(f.reload().create(body, f.options), error => error.reason === 'PROJECT_CREATION_STORAGE')
    assert.equal(calls, 0); assert.equal(f.values.get('copage-draft:v1:owner:26:tab'), '原草稿')
  }
})

test('成功后清理失败明确warning并保留UUID，恢复后先确认原项目再主动新建', async () => {
  const ids = [], f = fixture(async (_, __, config) => { ids.push(config.headers['Idempotency-Key']); return { data: { id: 41, groupId: 0 } } })
  const remove = f.storage.removeItem; f.storage.removeItem = () => { throw Error('denied') }
  const result = await f.creator.create(body, f.options)
  assert.match(result.creationTrackingWarning, /项目已创建/); assert.equal(saved(f).length, 1)
  const record = (await f.creator.listPending(f.options))[0]
  f.storage.removeItem = remove
  await f.creator.retry(record, f.options); await f.creator.create(body, f.options)
  assert.equal(ids[0], ids[1]); assert.notEqual(ids[1], ids[2])
})

test('回复后槽位变化不清理新记录，清理读取拒绝仍明确warning且保留原UUID', async () => {
  for (const mode of ['changed', 'denied']) {
    let prepared, denied = false
    const f = fixture(async () => {
      if (mode === 'changed') f.values.set(prepared.key, '{another record')
      else denied = true
      return { data: { id: 41, groupId: 0 } }
    })
    const getItem = f.storage.getItem
    f.storage.getItem = key => { if (denied) throw Error('denied'); return getItem(key) }
    const result = await f.creator.create(body, { ...f.options, onPrepared: record => { prepared = record } })
    assert.ok(result.creationTrackingWarning)
    if (mode === 'changed') { assert.match(result.creationTrackingWarning, /变化/); assert.equal(f.values.get(prepared.key), '{another record') }
    else assert.equal(JSON.parse(f.values.get(prepared.key)).requestId, prepared.requestId)
  }
})

test('不同账号、服务与归属精确隔离，多条摘要只读取当前namespace正文', async () => {
  const f = fixture(), cases = [f.options, { ...f.options, account: 'owner2' }, { ...f.options, service: 'https://other.example/api' }]
  for (const options of cases) await assert.rejects(f.creator.create(body, options))
  await assert.rejects(f.creator.create({ ...body, groupId: 3 }, f.options))
  f.reads.length = 0
  const records = await f.creator.listPending(f.options)
  assert.equal(records.length, 2); assert.deepEqual(records.map(r => r.groupId).sort(), [0, 3])
  assert.ok(f.reads.every(key => records.some(record => record.key === key)))
  const before = f.reads.length
  await assert.rejects(f.creator.retry(records[0], cases[1]), error => error.reason === 'PROJECT_CREATION_RECORD')
  await assert.rejects(f.creator.retry(records[0], cases[2]), error => error.reason === 'PROJECT_CREATION_RECORD')
  assert.equal(f.reads.length, before)
})

test('冒号和百分号等账号/服务字符不混入相邻namespace', async () => {
  const f = fixture(), options = { account: '用户:a%😀', service: 'https://example/api:a%' }
  await assert.rejects(f.creator.create(body, options))
  assert.equal((await f.creator.listPending(options)).length, 1)
  assert.equal((await f.creator.listPending({ ...options, account: options.account + 'x' })).length, 0)
})

test('空清单与扫描失败区分，坏记录不会返回部分或假空清单，原raw保留', async () => {
  const f = fixture(); assert.deepEqual(await f.creator.listPending(f.options), [])
  await assert.rejects(f.creator.create(body, f.options)); await assert.rejects(f.creator.create({ ...body, name: '另一个' }, f.options))
  const original = f.storage.key
  f.storage.key = () => { throw Error('denied') }
  await assert.rejects(f.creator.listPending(f.options), error => error.reason === 'PROJECT_CREATION_STORAGE')
  f.storage.key = original
  const [key] = saved(f)[1]; f.values.set(key, '{坏记录')
  await assert.rejects(f.creator.listPending(f.options), error => error.reason === 'PROJECT_CREATION_RECORD')
  assert.equal(f.values.get(key), '{坏记录')
})

test('记录严格校验UUID/version/字段/长度/归属/日期及payload槽位hash，不替换或发送', async () => {
  const f = fixture(); await assert.rejects(f.creator.create(body, f.options))
  const [key, raw] = saved(f)[0], record = JSON.parse(raw)
  for (const changed of [{ ...record, requestId: 'bad' }, { ...record, version: 2 }, { ...record, token: '不可保存' },
    { ...record, name: '名'.repeat(81) }, { ...record, description: '介'.repeat(301) }, { ...record, groupId: -1 },
    { ...record, groupId: '3' }, { ...record, createdAt: 0 }, { ...record, createdAt: Date.now() + 100000 },
    { ...record, description: '改槽内容' }]) {
    const broken = JSON.stringify(changed); f.values.set(key, broken)
    await assert.rejects(f.creator.listPending(f.options), error => error.reason === 'PROJECT_CREATION_RECORD')
    await assert.rejects(f.creator.create(body, f.options), error => error.reason === 'PROJECT_CREATION_RECORD')
    assert.equal(f.values.get(key), broken)
  }
  f.values.set(key, raw + ' '.repeat(4096))
  await assert.rejects(f.creator.listPending(f.options), error => error.reason === 'PROJECT_CREATION_RECORD')
})

test('retry必须原摘要对象及未改变完整raw；消失、改UUID/简介、损坏均不post', async () => {
  let calls = 0; const f = fixture(async () => { calls++; throw Error('lost') })
  await assert.rejects(f.creator.create(body, f.options))
  const descriptor = (await f.creator.listPending(f.options))[0], [key, raw] = saved(f)[0]
  await assert.rejects(f.creator.retry({ ...descriptor }, f.options), error => error.reason === 'PROJECT_CREATION_RECORD')
  for (const replacement of [null, '{bad', JSON.stringify({ ...JSON.parse(raw), description: '其他简介' }),
    JSON.stringify({ ...JSON.parse(raw), requestId: '11111111-1111-4111-8111-111111111111' })]) {
    if (replacement === null) f.values.delete(key); else f.values.set(key, replacement)
    await assert.rejects(f.creator.retry(descriptor, f.options), error => error.reason === 'PROJECT_CREATION_CHANGED')
  }
  assert.equal(calls, 1)
})

test('onPrepared在存妥与重新验证后收到原摘要，剥离内部选项且传递axios配置', async () => {
  let prepared; const f = fixture(async (path, input, config) => {
    assert.equal(path, '/projects'); assert.deepEqual(input, body)
    assert.equal(JSON.parse(f.values.get(prepared.key)).requestId, prepared.requestId)
    assert.equal(config.headers['Idempotency-Key'], prepared.requestId); assert.equal(config.headers.Custom, 'yes')
    assert.equal(config.timeout, 123); assert.equal(config.copageExpectedSessionToken, 'only-in-request')
    for (const key of ['account', 'service', 'isCurrent', 'onPrepared']) assert.equal(Object.hasOwn(config, key), false)
    return { data: { id: 41, groupId: 0 } }
  })
  await f.creator.create(body, { ...f.options, onPrepared: value => { prepared = value }, timeout: 123,
    headers: { Custom: 'yes', 'Idempotency-Key': 'caller-must-not-override' }, copageExpectedSessionToken: 'only-in-request' })
  assert.equal(Object.isFrozen(prepared), true)
})

test('onPrepared失败、改变槽位、取消或身份失效均不发送，原记录保留', async () => {
  for (const mode of ['failure', 'changed', 'abort', 'identity']) {
    let calls = 0, current = true; const abort = new AbortController()
    const f = fixture(async () => { calls++; return { data: { id: 41, groupId: 0 } } })
    await assert.rejects(f.creator.create(body, { ...f.options, signal: abort.signal, isCurrent: () => current,
      onPrepared: async record => {
        if (mode === 'failure') throw Error('callback failed')
        if (mode === 'changed') f.values.set(record.key, '{changed')
        if (mode === 'abort') abort.abort()
        if (mode === 'identity') current = false
      } }))
    assert.equal(calls, 0); assert.equal(saved(f).length, 1)
  }
})

test('取消或身份读取异常后的迟到回复保留原UUID，下次重载仍确认原项目', async () => {
  for (const mode of ['abort', 'identity', 'denied']) {
    const wait = deferred(), started = deferred(); let current = true, denied = false
    const f = fixture(() => { started.resolve(); return wait.promise }), controller = new AbortController()
    const pending = f.creator.create(body, { ...f.options, signal: controller.signal, isCurrent: () => {
      if (denied) throw Error('storage'); return current
    } })
    await started.promise
    const original = saved(f)[0][1]
    if (mode === 'abort') controller.abort()
    if (mode === 'identity') current = false
    if (mode === 'denied') denied = true
    wait.resolve({ data: { id: 41, groupId: 0 } })
    await assert.rejects(pending, error => error.name === 'AbortError')
    assert.equal(saved(f)[0][1], original)
    assert.equal((await f.reload().listPending(f.options))[0].requestId, JSON.parse(original).requestId)
  }
})

test('列表扫描前后身份拒绝不返回旧账号摘要，单条重试callback收到原对象', async () => {
  const f = fixture(); await assert.rejects(f.creator.create(body, f.options))
  let current = true; const key = f.storage.key
  f.storage.key = index => { const result = key(index); current = false; return result }
  await assert.rejects(f.creator.listPending({ ...f.options, isCurrent: () => current }), error => error.name === 'AbortError')
  f.storage.key = key
  const record = (await f.creator.listPending(f.options))[0]; let received
  await assert.rejects(f.creator.retry(record, { ...f.options, onPrepared: value => { received = value } }))
  assert.equal(received, record)
})

test('成功响应必须正安全id和原groupId，不可靠响应保留记录且不给成功摘要', async () => {
  for (const data of [{ id: 0, groupId: 0 }, { id: 1.5, groupId: 0 }, { id: 41, groupId: 3 }, { id: 41 }, null]) {
    const f = fixture(async () => ({ data }))
    await assert.rejects(f.creator.create(body, f.options), error => error.code === 500)
    assert.equal(saved(f).length, 1)
  }
})

test('错误归属/控制字符/超长输入与不可用crypto不发送，也不保存无效替代记录', async () => {
  let calls = 0; const f = fixture(async () => { calls++; return { data: { id: 41, groupId: 0 } } })
  for (const input of [{ ...body, name: '' }, { ...body, name: '控制\u007f' }, { ...body, name: '名'.repeat(81) },
    { ...body, description: '简\t介' }, { ...body, groupId: -1 }, { ...body, groupId: '3' }, { ...body, extra: true }]) {
    await assert.rejects(f.creator.create(input, f.options), error => error.reason === 'PROJECT_CREATION_INPUT')
  }
  await assert.rejects(createProjectCreator({ ...f.dependencies, crypto: {} }).create(body, f.options),
    error => error.reason === 'PROJECT_CREATION_CRYPTO')
  assert.equal(calls, 0); assert.equal(saved(f).length, 0)
})

test('延后清理时最终caller一次身份拒绝不消费确认，原UUID仍可重新读取并重试', async () => {
  const f = fixture(async (_, __, config) => {
    assert.equal(Object.hasOwn(config, 'deferCleanup'), false)
    return { data: { id: 41, groupId: 0 } }
  })
  const result = await f.creator.create(body, { ...f.options, deferCleanup: true })
  assert.equal(typeof result.confirmTracking, 'function'); assert.equal(saved(f).length, 1)
  // 最终caller无法核对身份，因此没有调用确认函数。
  const readCallerIdentity = () => { throw Error('single identity failure') }
  const acceptReply = reply => { readCallerIdentity(); return reply.confirmTracking() }
  assert.throws(() => acceptReply(result))
  const reload = f.reload(), record = (await reload.listPending(f.options))[0]
  const recovered = await reload.retry(record, { ...f.options, deferCleanup: true })
  assert.equal(saved(f).length, 1)
  const confirmed = recovered.confirmTracking()
  assert.equal(confirmed instanceof Promise, false)
  assert.equal(confirmed.data.id, 41); assert.equal(saved(f).length, 0)
})

test('延后确认清理失败返回warning且原记录保留，恢复后同步清理原槽位', async () => {
  const f = fixture(async () => ({ data: { id: 41, groupId: 0 } }))
  const result = await f.creator.create(body, { ...f.options, deferCleanup: true })
  const raw = saved(f)[0][1], remove = f.storage.removeItem
  f.storage.removeItem = () => { throw Error('denied') }
  const warning = result.confirmTracking()
  assert.match(warning.creationTrackingWarning, /项目已创建/)
  assert.equal(saved(f)[0][1], raw); assert.equal(warning instanceof Promise, false)
  f.storage.removeItem = remove
  assert.equal(result.confirmTracking().data.id, 41); assert.equal(saved(f).length, 0)
})

test('延后确认再次核对身份/取消；换账号或读取失败不清理原账号记录', async () => {
  for (const mode of ['changed', 'denied', 'abort']) {
    let current = true, denied = false; const controller = new AbortController()
    const f = fixture(async () => ({ data: { id: 41, groupId: 0 } }))
    const result = await f.creator.create(body, { ...f.options, deferCleanup: true, signal: controller.signal,
      isCurrent: () => { if (denied) throw Error('identity unavailable'); return current } })
    const raw = saved(f)[0][1]
    if (mode === 'changed') current = false
    if (mode === 'denied') denied = true
    if (mode === 'abort') controller.abort()
    assert.throws(() => result.confirmTracking(), error => error.name === 'AbortError')
    assert.equal(saved(f)[0][1], raw)
  }
})

test('助手与控制器同步确认清理后的一次身份读取失败不会恢复旧账号未知目标', async () => {
  let failOnce = false, identity = { account: 'owner', token: 'original-token' }, confirmations = 0
  const f = fixture(async () => ({ data: { id: 41, groupId: 0 } })), pending = new Map()
  const captured = identity
  const readIdentity = () => {
    if (failOnce) { failOnce = false; throw Error('transient identity read') }
    return identity
  }
  const operation = createProjectOperation({ pending, readIdentity, readState: async () => { throw Error('not used') } })
  const remove = f.storage.removeItem
  f.storage.removeItem = key => { remove(key); failOnce = true }
  await operation.run({ kind: 'create', ...body }, (config, onPrepared) => f.creator.create(body, {
    ...f.options, ...config, onPrepared, deferCleanup: true,
    isCurrent: () => { const current = readIdentity(); return current.account === captured.account && current.token === captured.token },
  }), () => { confirmations++ }, { trackedCreation: true })
  assert.equal(saved(f).length, 0); assert.equal(pending.size, 0); assert.equal(confirmations, 1)
  assert.equal(operation.snapshot().uncertain, null); assert.equal(operation.snapshot().notice.type, 'success')
  assert.match(operation.snapshot().error, /已收到确认/)
  identity = { account: 'other', token: 'other-token' }; operation.syncIdentity()
  identity = { account: 'owner', token: 'relogged-token' }; operation.syncIdentity()
  assert.equal(operation.snapshot().uncertain, null); assert.equal(pending.size, 0)
  assert.deepEqual(await f.creator.listPending(f.options), [])
})
