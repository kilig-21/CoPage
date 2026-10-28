import test from 'node:test'
import assert from 'node:assert/strict'
import { createHistoryRestore, restoreReply } from './historyRestore.js'
import { createHistoryRestoreStore } from './historyRestoreStore.js'

const firstId = '11111111-1111-4111-8111-111111111111'
const secondId = '22222222-2222-4222-8222-222222222222'
const lost = async () => { throw Error('reply lost') }
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
function fixture() {
  let identity = { account: 'owner', token: 'fake-token' }, denied = false, failOnce = false, allowed = true
  let result = lost, id = firstId
  const pending = new Map(), requests = [], confirmations = []
  const options = { service: '/api', docId: 509, pending,
    readIdentity: () => { if (denied || failOnce) { failOnce = false; throw Error('storage') } return identity },
    ready: () => allowed, newRequestId: () => id,
    perform: (target, config) => { requests.push({ target, config }); return result(target, config) },
    confirmed: (target, data) => confirmations.push({ target, data }) }
  return { operation: createHistoryRestore(options), reload: extra => createHistoryRestore({ ...options, ...extra }), pending, requests, confirmations,
    identity: value => { identity = value }, deny: value => { denied = value }, failOnce: () => { failOnce = true },
    allow: value => { allowed = value }, result: value => { result = value }, id: value => { id = value } }
}

test('丢回复后重新读取或预览不改变原目标；确认沿用原UUID与预期版本', async () => {
  const f = fixture(); await f.operation.start(0, 1)
  const original = f.operation.snapshot().target
  assert.deepEqual(original, { targetRevision: 0, expectedRevision: 1, requestId: firstId })
  assert.equal(Object.isFrozen(original), true)
  f.operation.captureContext() // 独立读取没有恢复写入。
  f.id(secondId); await f.operation.start(7, 2)
  assert.equal(f.requests.length, 1)
  f.result(async () => ({ data: { revision: 2, applied: false } }))
  await f.operation.retryOriginal()
  assert.equal(f.requests[1].target, original)
  assert.equal(f.requests[1].config.copageExpectedSessionToken, 'fake-token')
  assert.equal(f.pending.size, 0)
  assert.match(f.operation.snapshot().notice.message, /已确认原恢复.*本次没有生成新版本/)
  assert.equal(f.operation.snapshot().notice.type, 'info')
  assert.equal(f.confirmations.length, 1)
})
test('同步锁阻止重复点击及另一个新恢复', async () => {
  const wait = deferred(), f = fixture(); f.result(() => wait.promise)
  const run = f.operation.start(0, 1)
  await f.operation.start(1, 1); await f.operation.retryOriginal()
  assert.equal(f.requests.length, 1); assert.equal(f.operation.snapshot().busy, true)
  wait.resolve({ data: { revision: 2, applied: true } }); await run
  assert.match(f.operation.snapshot().notice.message, /已恢复，生成版本 2/)
  assert.equal(f.operation.snapshot().busy, false)
})
test('关闭取消保留原请求；重开确认，旧成功不能解除新等待', async () => {
  const wait = deferred(), f = fixture(); f.result(() => wait.promise)
  const run = f.operation.start(0, 1), original = f.operation.snapshot().target
  f.operation.deactivate()
  assert.equal(f.requests[0].config.signal.aborted, true)
  const again = f.reload(); assert.equal(again.snapshot().target, original)
  wait.resolve({ data: { revision: 2, applied: true } }); await run
  assert.equal(f.confirmations.length, 0); assert.equal(again.snapshot().target, original)
  f.result(async () => ({ data: { revision: 2, applied: false } })); await again.retryOriginal()
  assert.equal(f.pending.size, 0); assert.equal(f.confirmations.length, 1)
})
test('StrictMode清理后重新激活仍可确认，旧弹窗上下文失效', async () => {
  const f = fixture(); await f.operation.start(0, 1)
  const ticket = f.operation.prepareEndWaiting()
  f.operation.deactivate(); f.operation.activate()
  assert.equal(f.operation.endWaiting(ticket), false)
  assert.equal(f.operation.snapshot().target.requestId, firstId)
  f.result(async () => ({ data: { revision: 2, applied: false } })); await f.operation.retryOriginal()
  assert.equal(f.pending.size, 0)
})
test('403/404/40902/收据冲突均不说明原请求未执行', async () => {
  for (const code of [400, 401, 403, 404, 40902, 40903, 40904]) {
    const f = fixture(); await f.operation.start(0, 1)
    f.result(async () => { throw { code, message: '当前请求不能确认' } })
    await f.operation.retryOriginal()
    assert.equal(f.operation.snapshot().target.requestId, firstId)
    assert.equal(f.operation.snapshot().reviewFailed, true)
    await f.operation.start(0, 2)
    assert.equal(f.requests.length, 2); assert.equal(f.confirmations.length, 0)
  }
})
test('坏响应、错误revision和缺applied保留原请求，不报告成功', async () => {
  for (const data of [null, {}, { revision: 3, applied: true }, { revision: 2, applied: 'false' },
    { revision: '2', applied: true }, { revision: 2 }, { revision: -1, applied: true }, { revision: Infinity, applied: false }]) {
    const f = fixture(); f.result(async () => ({ data })); await f.operation.start(0, 1)
    assert.equal(f.operation.snapshot().target.requestId, firstId)
    assert.equal(f.operation.snapshot().notice, null); assert.equal(f.confirmations.length, 0)
  }
})
test('恢复前及原请求确认时动态权限/连接门禁生效', async () => {
  const f = fixture(); f.allow(false); await f.operation.start(0, 1)
  assert.equal(f.requests.length, 0); assert.equal(f.pending.size, 0)
  f.allow(true); await f.operation.start(0, 1)
  f.allow(false); await f.operation.retryOriginal()
  assert.equal(f.requests.length, 1); assert.equal(f.operation.snapshot().target.requestId, firstId)
})
test('账号与service/document范围隔离；重新登录原账号保留原请求', async () => {
  const f = fixture(); await f.operation.start(0, 1)
  assert.equal(f.reload({ docId: 510 }).snapshot().target, null)
  assert.equal(f.reload({ service: 'http://other/api' }).snapshot().target, null)
  f.identity({ account: 'other', token: 'other-token' }); f.operation.syncIdentity()
  assert.equal(f.operation.snapshot().target, null)
  assert.equal(f.operation.snapshot().notice, null)
  f.identity({ account: 'owner', token: 'new-token' }); f.operation.syncIdentity()
  assert.equal(f.operation.snapshot().target.requestId, firstId)
})
test('写入中切换账号取消旧尝试，迟到回复不泄露原结果', async () => {
  const wait = deferred(), f = fixture(); f.result(() => wait.promise)
  const run = f.operation.start(0, 1)
  f.identity({ account: 'other', token: 'other-token' }); f.operation.syncIdentity()
  assert.equal(f.requests[0].config.signal.aborted, true)
  wait.resolve({ data: { revision: 2, applied: true } }); await run
  assert.equal(f.operation.snapshot().target, null); assert.equal(f.operation.snapshot().notice, null)
  assert.equal(f.confirmations.length, 0)
  f.identity({ account: 'owner', token: 'new-token' }); f.operation.syncIdentity()
  assert.equal(f.operation.snapshot().target.requestId, firstId)
})
test('没有存储事件的身份变更也不能接受旧回复', async () => {
  const wait = deferred(), f = fixture(); f.result(() => wait.promise)
  const run = f.operation.start(0, 1)
  f.identity({ account: 'other', token: 'other-token' })
  wait.resolve({ data: { revision: 2, applied: true } }); await run
  assert.equal(f.operation.snapshot().target, null); assert.equal(f.operation.snapshot().busy, false)
  assert.equal(f.pending.size, 1); assert.equal(f.confirmations.length, 0)
})
test('存储异常不发送，隐藏原账号元信息；恢复读取后找回原等待', async () => {
  const f = fixture(); await f.operation.start(0, 1)
  f.deny(true); f.operation.syncIdentity(); await f.operation.start(1, 2)
  assert.equal(f.requests.length, 1); assert.equal(f.operation.snapshot().target, null)
  assert.equal(f.operation.snapshot().notice, null); assert.equal(f.pending.size, 1)
  f.deny(false); f.operation.syncIdentity()
  assert.equal(f.operation.snapshot().target.requestId, firstId)
})
test('只一次回复后身份读取抛错也保留等待，不被finally恢复误清', async () => {
  const wait = deferred(), f = fixture(); f.result(() => wait.promise)
  const run = f.operation.start(0, 1)
  f.failOnce(); wait.resolve({ data: { revision: 2, applied: true } }); await run
  assert.equal(f.operation.snapshot().target.requestId, firstId)
  assert.equal(f.operation.snapshot().busy, false); assert.equal(f.confirmations.length, 0)
  f.result(async () => ({ data: { revision: 2, applied: false } })); await f.operation.retryOriginal()
  assert.equal(f.pending.size, 0)
})
test('确认结果已验证后列表更新失败不重新变为未知', async () => {
  const f = fixture(), op = f.reload({ confirmed: () => { throw Error('list failed') } })
  f.result(async () => ({ data: { revision: 2, applied: true } })); await op.start(0, 1)
  assert.equal(op.snapshot().target, null); assert.equal(f.pending.size, 0)
  assert.match(op.snapshot().error, /恢复已确认/)
})
test('明确结束等待允许后续恢复，但旧确认不能删除新目标', async () => {
  const f = fixture(); await f.operation.start(0, 1)
  const ticket = f.operation.prepareEndWaiting()
  assert.equal(f.operation.endWaiting(ticket), true); assert.equal(f.pending.size, 0)
  assert.match(f.operation.snapshot().notice.message, /可能已经生效/)
  f.id(secondId); await f.operation.start(7, 2)
  assert.equal(f.operation.endWaiting(ticket), false)
  assert.equal(f.operation.snapshot().target.requestId, secondId)
})
test('结束等待弹窗的原token与当前目标都必须匹配，忙碌时不能结束', async () => {
  const f = fixture(); await f.operation.start(0, 1)
  const ticket = f.operation.prepareEndWaiting()
  f.identity({ account: 'owner', token: 'new-token' })
  assert.equal(f.operation.endWaiting(ticket), false)
  f.operation.syncIdentity()
  const current = f.operation.prepareEndWaiting(), wait = deferred(); f.result(() => wait.promise)
  const run = f.operation.retryOriginal()
  assert.equal(f.operation.prepareEndWaiting(), null); assert.equal(f.operation.endWaiting(current), false)
  wait.reject(Error('lost again')); await run
  assert.equal(f.operation.snapshot().target.requestId, firstId)
})
test('被取消的旧回复不能清除后来开始的原请求确认', async () => {
  const old = deferred(), fresh = deferred(), f = fixture(); f.result(() => old.promise)
  const run = f.operation.start(0, 1)
  f.operation.cancel(); f.result(() => fresh.promise)
  const retry = f.operation.retryOriginal()
  old.resolve({ data: { revision: 2, applied: true } }); await run
  assert.equal(f.operation.snapshot().busy, true); assert.equal(f.confirmations.length, 0)
  fresh.resolve({ data: { revision: 2, applied: false } }); await retry
  assert.equal(f.operation.snapshot().target, null); assert.equal(f.confirmations.length, 1)
})
test('已关闭controller的旧结束等待弹窗不能影响重开后的同target在途确认', async () => {
  const f = fixture(); await f.operation.start(0, 1)
  const ticket = f.operation.prepareEndWaiting()
  f.operation.deactivate()
  const again = f.reload(), wait = deferred(); f.result(() => wait.promise)
  const run = again.retryOriginal()
  assert.equal(f.operation.endWaiting(ticket), false)
  assert.equal(again.snapshot().busy, true); assert.equal(f.pending.size, 1)
  wait.resolve({ data: { revision: 2, applied: false } }); await run
  assert.equal(f.confirmations.length, 1); assert.equal(f.pending.size, 0)
})
test('上下文观察到身份变更后不因原token重新出现复活', () => {
  const f = fixture(), context = f.operation.captureContext()
  f.identity({ account: 'other', token: 'other-token' })
  assert.equal(f.operation.isCurrent(context), false)
  f.identity({ account: 'owner', token: 'fake-token' })
  assert.equal(f.operation.isCurrent(context), false)
})
test('不同doc/service及同doc重新挂载的controller不能接纳旧读取上下文', () => {
  const f = fixture(), context = f.operation.captureContext()
  assert.equal(f.reload({ docId: 510 }).isCurrent(context), false)
  assert.equal(f.reload({ service: 'http://other/api' }).isCurrent(context), false)
  assert.equal(f.reload().isCurrent(context), false)
  assert.equal(f.operation.isCurrent(context), true)
})
test('新账号不可使用旧读取/弹窗上下文；生命周期重开使旧上下文失效', () => {
  const f = fixture(), context = f.operation.captureContext()
  assert.equal(f.operation.isCurrent(context), true)
  f.identity({ account: 'other', token: 'other-token' }); f.operation.syncIdentity()
  assert.equal(f.operation.isCurrent(context), false)
  f.identity({ account: 'owner', token: 'fake-token' }); f.operation.syncIdentity()
  assert.equal(f.operation.isCurrent(context), false)
  const current = f.operation.captureContext()
  f.operation.deactivate(); f.operation.activate()
  assert.equal(f.operation.isCurrent(current), false)
})
test('非法版本或UUID不发请求、不留下占位；收据只保留三项元信息', async () => {
  const f = fixture()
  for (const [target, expected] of [[-1, 1], [0, -1], [0, Number.MAX_SAFE_INTEGER], ['0', 1], [0, Infinity]])
    await f.operation.start(target, expected)
  f.id('invalid'); await f.operation.start(0, 1)
  assert.equal(f.requests.length, 0); assert.equal(f.pending.size, 0)
  f.id(firstId); await f.operation.start(0, 1)
  assert.deepEqual(Object.keys([...f.pending.values()][0]).sort(), ['expectedRevision', 'requestId', 'targetRevision'])
  assert.equal(JSON.stringify([...f.pending]).includes('fake-token'), false)
})
test('响应验证要求严格原expected+1，而非预览版本或最新列表版本', () => {
  const target = { targetRevision: 99, expectedRevision: 24, requestId: firstId }
  assert.match(restoreReply(target, { revision: 25, applied: false }), /结果为版本 25/)
  assert.throws(() => restoreReply(target, { revision: 100, applied: true }))
})

function durableFixture({ lock } = {}) {
  const disk = new Map([['unrelated-draft', 'keep']]), calls = []
  let session = { account: 'owner', token: 'secret-token' }, failRead = false, failWrite = false, failRemove = false
  let response = lost, id = firstId, queue = Promise.resolve()
  const storage = {
    getItem: key => { if (failRead) throw Error('denied'); return disk.get(key) ?? null },
    setItem: (key, value) => { if (failWrite) throw Error('quota'); disk.set(key, value) },
    removeItem: key => { if (failRemove) throw Error('denied'); disk.delete(key) },
  }
  const serial = (_name, action) => { const result = queue.then(action); queue = result.catch(() => {}); return result }
  const store = () => createHistoryRestoreStore({ getStorage: () => storage, withLock: lock === false ? undefined : lock || serial })
  const open = (extra = {}) => createHistoryRestore({ service: '/api', docId: 509, pending: store(),
    readIdentity: () => session, ready: () => true, newRequestId: () => id,
    perform: (target, config) => { calls.push({ target, config }); return response(target, config) }, ...extra })
  return { disk, storage, store, open, calls, response: value => { response = value }, id: value => { id = value },
    identity: value => { session = value }, fail: (kind, value) => { if (kind === 'read') failRead = value; if (kind === 'write') failWrite = value; if (kind === 'remove') failRemove = value },
    slot: () => [...disk.keys()].find(k => k !== 'unrelated-draft') }
}

test('持久记录经独立实例重开与原账号新token仍保留UUID，只在主动确认时发送', async () => {
  const f = durableFixture(), old = f.open(); await old.start(1, 9)
  const raw = f.disk.get(f.slot()); assert.equal(raw.includes('secret-token'), false)
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['expectedRevision', 'requestId', 'targetRevision', 'version'])
  old.deactivate(); f.identity({ account: 'owner', token: 'new-token' })
  const reopened = f.open(); assert.equal(reopened.snapshot().target.requestId, firstId)
  await reopened.start(3, 10); assert.equal(f.calls.length, 1)
  f.response(async () => ({ data: { revision: 10, applied: false } })); await reopened.retryOriginal()
  assert.deepEqual(f.calls[1].target, { targetRevision: 1, expectedRevision: 9, requestId: firstId })
  assert.equal(f.calls[1].config.copageExpectedSessionToken, 'new-token')
  assert.equal(reopened.snapshot().target, null); assert.equal(f.disk.size, 1); assert.equal(f.disk.get('unrelated-draft'), 'keep')
})
test('持久记录按账号、文档和服务隔离，退出后不展示原等待', async () => {
  const f = durableFixture(), a = f.open(); await a.start(1, 9)
  for (const extra of [{ service: 'http://other/api' }, { docId: 510 }]) assert.equal(f.open(extra).snapshot().target, null)
  f.identity({ account: 'other', token: 'other-token' }); a.syncIdentity(); assert.equal(a.snapshot().target, null)
  assert.equal(f.open().snapshot().target, null)
  f.identity({ account: 'owner', token: 'again' }); a.syncIdentity(); assert.equal(a.snapshot().target.requestId, firstId)
})
test('记录写入失败或安全锁不可用时零发送，且不降级成仅内存恢复', async () => {
  for (const kind of ['write', 'lock']) {
    const f = durableFixture({ lock: kind === 'lock' ? false : undefined }); if (kind === 'write') f.fail('write', true)
    const op = f.open(); await op.start(1, 9)
    assert.equal(f.calls.length, 0); assert.equal(f.disk.size, 1); assert.equal(op.snapshot().trackingFailed, true); assert.equal(op.snapshot().busy, false)
  }
})
test('坏记录、超大记录和版本不符均保留原字节、不自动覆盖或发送', async () => {
  for (const bad of ['{bad', 'x'.repeat(1025), JSON.stringify({ version: 2, requestId: firstId, targetRevision: 1, expectedRevision: 9 }),
    JSON.stringify({ version: 1, requestId: firstId, targetRevision: 1, expectedRevision: 9, token: 'unexpected' })]) {
    const f = durableFixture(); await f.open().start(1, 9); const slot = f.slot(); f.disk.set(slot, bad)
    const op = f.open(); await op.start(2, 10); await op.retryOriginal()
    assert.equal(f.disk.get(slot), bad); assert.equal(f.calls.length, 1); assert.equal(op.snapshot().trackingFailed, true)
  }
})
test('暂时读取失败隐藏旧目标；恢复存储后能重新找回原等待', async () => {
  const f = durableFixture(), op = f.open(); await op.start(1, 9); f.fail('read', true)
  op.syncIdentity(); assert.equal(op.snapshot().target, null); await op.start(1, 10); assert.equal(f.calls.length, 1)
  f.fail('read', false); op.syncIdentity(); assert.equal(op.snapshot().target.requestId, firstId); assert.equal(op.snapshot().trackingFailed, false)
})
test('两个独立标签同时准备时只创建一个UUID，后来的标签只显示原确认入口', async () => {
  const f = durableFixture(), a = f.open({ newRequestId: () => firstId }); const pa = a.start(1, 9)
  const b = f.open({ newRequestId: () => secondId }); const pb = b.start(3, 9)
  await Promise.all([pa, pb]); assert.equal(f.calls.length, 1)
  assert.equal(a.snapshot().target.requestId, b.snapshot().target.requestId)
  assert.deepEqual(a.snapshot().target, { targetRevision: 1, expectedRevision: 9, requestId: firstId })
  assert.equal(JSON.parse(f.disk.get(f.slot())).requestId, firstId)
})
test('等待跨标签锁时退出/关闭，锁后来授予也零写入零发送', async () => {
  for (const action of ['logout', 'close']) {
    const gate = deferred(), f = durableFixture({ lock: async (_key, task) => { await gate.promise; return task() } }), op = f.open()
    const run = op.start(1, 9)
    if (action === 'logout') { f.identity({ account: 'other', token: 'other' }); op.syncIdentity() } else op.deactivate()
    gate.resolve(); await run
    assert.equal(f.calls.length, 0); assert.equal(f.disk.size, 1); assert.equal(op.snapshot().busy, false)
  }
})
test('服务端确认成功但本地删除失败仍报告已确认并保留原UUID供去重重试', async () => {
  const f = durableFixture(), op = f.open(); f.fail('remove', true)
  f.response(async () => ({ data: { revision: 10, applied: true } })); await op.start(1, 9)
  assert.match(op.snapshot().notice.message, /已恢复/); assert.match(op.snapshot().error, /恢复已确认.*本地确认记录/)
  assert.equal(op.snapshot().target.requestId, firstId); assert.ok(f.slot())
  f.fail('remove', false); f.response(async () => ({ data: { revision: 10, applied: false } })); await op.retryOriginal()
  assert.equal(op.snapshot().target, null); assert.equal(f.disk.size, 1); assert.equal(f.calls[1].target.requestId, firstId)
})
test('没有storage事件时迟到旧成功也不能清理被替换的持久记录', async () => {
  const f = durableFixture(), wait = deferred(), op = f.open(); f.response(() => wait.promise)
  const run = op.start(1, 9); for (let i = 0; i < 20 && !f.calls.length; i++) await Promise.resolve(); assert.equal(f.calls.length, 1)
  const replacement = JSON.stringify({ version: 1, requestId: secondId, targetRevision: 2, expectedRevision: 10 })
  f.disk.set(f.slot(), replacement); wait.resolve({ data: { revision: 10, applied: true } }); await run
  assert.equal(f.disk.get(f.slot()), replacement); assert.equal(op.snapshot().target.requestId, secondId); assert.equal(op.snapshot().notice, null)
})
test('确认期间其他标签清理原槽，storage同步会取消在途确认并忽略迟到成功', async () => {
  const f = durableFixture(), wait = deferred(), op = f.open(); f.response(() => wait.promise)
  const run = op.start(1, 9); for (let i = 0; i < 20 && !f.calls.length; i++) await Promise.resolve(); assert.equal(f.calls.length, 1)
  f.disk.delete(f.slot()); op.syncIdentity(); assert.equal(f.calls[0].config.signal.aborted, true)
  wait.resolve({ data: { revision: 10, applied: true } }); await run
  assert.equal(op.snapshot().target, null); assert.equal(op.snapshot().notice, null)
})
test('异步结束等待核对原槽；旧弹窗不能删除新记录', async () => {
  const f = durableFixture(), op = f.open(); await op.start(1, 9); const ticket = op.prepareEndWaiting()
  const replacement = JSON.stringify({ version: 1, requestId: secondId, targetRevision: 2, expectedRevision: 10 })
  f.disk.set(f.slot(), replacement)
  assert.equal(await op.endWaiting(ticket), false); assert.equal(f.disk.get(f.slot()), replacement); assert.equal(op.snapshot().target.requestId, secondId)
  assert.equal(await op.endWaiting(op.prepareEndWaiting()), true); assert.equal(f.disk.size, 1)
})
test('无关草稿storage事件不会打断同UUID的在途确认', async () => {
  const f = durableFixture(), wait = deferred(), op = f.open(); f.response(() => wait.promise)
  const run = op.start(1, 9); for (let i = 0; i < 20 && !f.calls.length; i++) await Promise.resolve(); assert.equal(f.calls.length, 1)
  f.disk.set('unrelated-draft', 'another tab editing'); op.syncIdentity()
  assert.equal(f.calls[0].config.signal.aborted, false); assert.equal(op.snapshot().busy, true)
  wait.resolve({ data: { revision: 10, applied: true } }); await run
  assert.match(op.snapshot().notice.message, /已恢复/); assert.equal(f.disk.get('unrelated-draft'), 'another tab editing')
})
test('切换账号且原请求槽不可读时也立即隐藏旧成功，旧读取上下文失效', async () => {
  const f = durableFixture(), op = f.open(); f.response(async () => ({ data: { revision: 10, applied: true } }))
  await op.start(1, 9); assert.ok(op.snapshot().notice)
  const old = op.captureContext(), epoch = op.snapshot().identityEpoch
  f.identity({ account: 'other', token: 'other-token' }); f.fail('read', true); op.syncIdentity()
  assert.equal(op.snapshot().notice, null); assert.equal(op.snapshot().target, null)
  assert.equal(op.snapshot().identityEpoch, epoch + 1); assert.equal(op.isCurrent(old), false)
})
