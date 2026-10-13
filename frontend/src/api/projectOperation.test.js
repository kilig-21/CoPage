import test from 'node:test'
import assert from 'node:assert/strict'
import { canAcknowledgeProjectCreation, createProjectOperation, projectStateMessage } from './projectOperation.js'

const oldId = '11111111-1111-4111-8111-111111111111', newId = '22222222-2222-4222-8222-222222222222'
const rename = { kind: 'rename', projectId: 31, name: '原提交', description: '原简介' }
const add = { kind: 'add', projectId: 31, docId: 52, title: '本人资料' }
const project = { id: 31, groupId: 0, name: '原提交', description: '原简介', archived: false, canManage: true }
const relation = { projectId: 31, docId: 52, docTitle: '本人资料', associationId: oldId, projectArchived: false }
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
function fixture(readState = async () => ({ data: project })) {
  let identity = { account: 'owner', token: 'fake-owner-token' }, denied = false
  const pending = new Map(), updates = [], confirmations = []
  const options = { pending, readIdentity: () => { if (denied) throw Error('storage'); return identity }, readState,
    changed: value => updates.push(value), confirmed: target => confirmations.push(target) }
  return { operation: createProjectOperation(options), reload: () => createProjectOperation(options), pending, updates, confirmations,
    deny: value => { denied = value }, identity: value => { identity = value } }
}
const lost = async () => { throw Error('confirmation lost') }

test('同步锁覆盖不同写入口，成功确认只有一次', async () => {
  const wait = deferred(), f = fixture(); let writes = 0
  const first = f.operation.run(rename, () => { writes++; return wait.promise })
  await f.operation.run(add, () => { writes++; return { data: { changed: true } } })
  assert.equal(writes, 1)
  wait.resolve({ data: null }); await first
  assert.equal(f.confirmations.length, 1); assert.equal(f.operation.snapshot().pending, null)
})
test('丢回复冻结原提交，不随输入变化或其他入口重试改变目标', async () => {
  const f = fixture(); const target = { ...rename }
  const run = f.operation.run(target, lost); target.name = '后来输入'; await run
  assert.equal(f.operation.snapshot().uncertain.name, '原提交')
  let repeated = 0; await f.operation.run(add, () => { repeated++; return { data: { changed: true } } })
  assert.equal(repeated, 0); assert.equal(f.pending.get('owner').projectId, 31)
  assert.deepEqual(Object.keys(f.pending.get('owner')).sort(), Object.keys(rename).sort())
})
test('关闭页面取消等待后，重进同账号仍核对原目标，迟到成功不通知新页面', async () => {
  const wait = deferred(), f = fixture(); let signal, navigation = 0
  const run = f.operation.run(rename, config => { signal = config.signal; return wait.promise }, () => navigation++)
  f.operation.cancel(); assert.equal(signal.aborted, true)
  const again = f.reload(); assert.equal(again.snapshot().uncertain.projectId, 31)
  wait.resolve({ data: null }); await run
  assert.equal(navigation, 0); assert.equal(f.confirmations.length, 0)
  assert.equal(again.snapshot().uncertain.projectId, 31)
})
test('原目标核对成功才解除暂停，提示信息态且不自动重放写操作', async () => {
  const queries = [], f = fixture(async (target, config) => { queries.push({ target, config }); return { data: project } })
  await f.operation.run(rename, lost); await f.operation.review()
  assert.equal(queries.length, 1); assert.equal(queries[0].target.projectId, 31)
  assert.equal(queries[0].config.copageExpectedSessionToken, 'fake-owner-token')
  assert.equal(f.operation.snapshot().uncertain, null); assert.equal(f.pending.size, 0)
  assert.equal(f.operation.snapshot().notice.type, 'info'); assert.equal(f.confirmations.length, 1)
})
test('核对403/404、旧ID及缺字段均保留未知，不推断未关联', async () => {
  for (const reply of [403, 404, { ...relation, docId: 99 }, { ...relation, associationId: undefined }, { ...relation, projectArchived: undefined }]) {
    const f = fixture(async () => { if (typeof reply === 'number') throw { code: reply }; return { data: reply } })
    await f.operation.run(add, lost); await f.operation.review()
    assert.equal(f.operation.snapshot().uncertain.docId, 52); assert.equal(f.pending.size, 1)
    assert.equal(f.operation.snapshot().checking, false); assert.equal(f.confirmations.length, 0)
  }
})
test('已归档项目可以核对，当前权限丧失只陈述事实', async () => {
  const f = fixture(async () => ({ data: { ...project, archived: true, canManage: false } }))
  await f.operation.run({ kind: 'archive', projectId: 31 }, lost); await f.operation.review()
  assert.match(f.operation.snapshot().notice.message, /当前已归档/)
  assert.match(f.operation.snapshot().notice.message, /没有管理权限/)
})
test('旧关联移出后重新加入，只提示新关联，不重新删除新代次', async () => {
  const f = fixture(async () => ({ data: { ...relation, associationId: newId } }))
  let deletes = 0
  await f.operation.run({ ...add, kind: 'remove', associationId: oldId }, async () => { deletes++; throw Error('lost') })
  await f.operation.review()
  assert.equal(deletes, 1); assert.match(f.operation.snapshot().notice.message, /当前存在新关联/)
  assert.equal(f.operation.snapshot().notice.data.associationId, newId)
})
test('回复后的账号读取异常保留原目标并结束等待，恢复后可核对', async () => {
  const wait = deferred(), f = fixture()
  const run = f.operation.run(rename, () => wait.promise)
  f.deny(true); wait.resolve({ data: null }); await run
  assert.equal(f.operation.snapshot().pending, null); assert.equal(f.operation.snapshot().uncertain.projectId, 31)
  assert.equal(f.confirmations.length, 0)
  f.deny(false); await f.operation.review(); assert.equal(f.operation.snapshot().uncertain, null)
})
test('写前身份不可读不发送，身份变化不显示另一账号待核对目标', async () => {
  const f = fixture(); let writes = 0
  f.deny(true); await f.operation.run(rename, () => { writes++; return { data: null } }); assert.equal(writes, 0)
  f.deny(false); await f.operation.run(rename, lost)
  f.identity({ account: 'other', token: 'fake-other-token' }); f.operation.syncIdentity()
  assert.equal(f.operation.snapshot().uncertain, null)
  const other = f.reload(); assert.equal(other.snapshot().uncertain, null)
  f.identity({ account: 'owner', token: 'new-owner-token' }); f.operation.syncIdentity()
  assert.equal(f.operation.snapshot().uncertain.projectId, 31)
})
test('回复后只一次身份读取抛错，finally恢复也不能放开未确认写入', async () => {
  for (const reviewing of [false, true]) {
    const wait = deferred(); let failOnce = false, confirmations = 0
    const operation = createProjectOperation({ pending: new Map(), readIdentity: () => {
      if (failOnce) { failOnce = false; throw Error('single read failure') }
      return { account: 'owner', token: 'fake-token' }
    }, readState: () => wait.promise, confirmed: () => confirmations++ })
    if (reviewing) await operation.run(rename, lost)
    const run = reviewing ? operation.review() : operation.run(rename, () => wait.promise)
    failOnce = true; wait.resolve({ data: reviewing ? project : null }); await run
    assert.equal(operation.snapshot().pending, null); assert.equal(operation.snapshot().checking, false)
    assert.equal(operation.snapshot().uncertain.projectId, 31); assert.equal(confirmations, 0)
    let writes = 0; await operation.run(add, () => { writes++; return { data: { changed: true } } })
    assert.equal(writes, 0)
  }
})
test('核对被取消后旧回复不能解除原暂停或覆盖新核对', async () => {
  const first = deferred(), second = deferred(); let count = 0
  const f = fixture(() => (++count === 1 ? first.promise : second.promise))
  await f.operation.run(rename, lost); const old = f.operation.review(); f.operation.cancel()
  const current = f.operation.review(); first.resolve({ data: project }); await old
  assert.equal(f.operation.snapshot().checking, true); assert.equal(f.operation.snapshot().uncertain.projectId, 31)
  second.resolve({ data: project }); await current
  assert.equal(f.operation.snapshot().uncertain, null); assert.equal(f.confirmations.length, 1)
})
test('无ID创建不会用状态接口或同名自动确认，必须明确人工核对', async () => {
  let reads = 0; const f = fixture(async () => { reads++; return { data: project } })
  await f.operation.run({ kind: 'create', groupId: 0, name: '同名', description: '' }, lost)
  await f.operation.review(); assert.equal(reads, 0); assert.equal(f.operation.snapshot().uncertain.name, '同名')
  f.operation.acknowledgeCreate(); assert.equal(f.operation.snapshot().uncertain, null)
  assert.equal(f.operation.snapshot().notice.type, 'info')
})
test('无效成功关联/创建回复不能显示成功或解除写暂停', async () => {
  for (const [target, data] of [[add, {}], [{ kind: 'create', groupId: 3, name: '组项目' }, { id: 5, groupId: 0 }]]) {
    const f = fixture(); await f.operation.run(target, async () => ({ data }))
    assert.equal(f.operation.snapshot().notice, null); assert.ok(f.operation.snapshot().uncertain)
    assert.equal(f.confirmations.length, 0)
  }
})
test('未关联是显式null，非法UUID或项目ID不当作可靠观察', () => {
  assert.match(projectStateMessage(add, { ...relation, associationId: null }), /当前未关联/)
  assert.throws(() => projectStateMessage(add, { ...relation, associationId: '' }))
  assert.throws(() => projectStateMessage(rename, { ...project, id: 32 }))
})
test('原目标不可核对时须明确结束等待，保留未知警告而不重发或追认成功', async () => {
  let reads = 0; const f = fixture(async () => { reads++; throw { code: 404 } })
  await f.operation.run(rename, lost); const target = f.operation.snapshot().uncertain
  f.operation.endWaiting(target); assert.equal(f.operation.snapshot().uncertain, target)
  await f.operation.review(); assert.equal(f.operation.snapshot().reviewFailed, true)
  f.operation.endWaiting({ ...target }); assert.equal(f.operation.snapshot().uncertain, target)
  f.operation.endWaiting(target); assert.equal(f.operation.snapshot().uncertain, null)
  assert.equal(f.pending.size, 0); assert.equal(reads, 1); assert.equal(f.confirmations.length, 0)
  assert.equal(f.operation.snapshot().notice.type, 'warning'); assert.match(f.operation.snapshot().notice.message, /结果仍未知/)
  let writes = 0; await f.operation.run(add, async () => { writes++; return { data: { changed: true } } })
  assert.equal(writes, 1)
})
test('旧结束等待确认、其他身份和进行中的核对不能解除当前未知目标', async () => {
  const wait = deferred(); let held = false
  const f = fixture(async () => { if (held) return wait.promise; throw { code: 403 } })
  await f.operation.run(rename, lost); await f.operation.review(); const original = f.operation.snapshot().uncertain
  held = true; const review = f.operation.review(); f.operation.endWaiting(original)
  assert.equal(f.operation.snapshot().uncertain, original)
  wait.reject(Error('failed')); await review
  f.identity({ account: 'other', token: 'fake-other-token' }); f.operation.endWaiting(original)
  assert.equal(f.pending.get('owner'), original)
  f.identity({ account: 'owner', token: 'new-owner-token' }); f.operation.syncIdentity(); held = false
  await f.operation.review(); f.operation.endWaiting(original)
  await f.operation.run({ ...add }, lost); await f.operation.review()
  f.operation.endWaiting(original); assert.equal(f.operation.snapshot().uncertain.docId, 52)
})
test('人工创建核对只能在原归属的进行中、原名称可靠列表完成', () => {
  for (const groupId of [0, 3]) {
    const target = { kind: 'create', groupId, name: '原名称' }
    const view = { groupId, keyword: target.name, scope: groupId ? 'group' : 'personal', archived: false, listed: {}, busy: false, loading: false }
    assert.equal(canAcknowledgeProjectCreation(target, view), true)
    for (const change of [{ scope: 'all' }, { scope: groupId ? 'personal' : 'group' }, { archived: true }, { keyword: '后来输入' },
      { groupId: groupId + 1 }, { listed: null }, { loading: true }, { busy: true }]) {
      assert.equal(canAcknowledgeProjectCreation(target, { ...view, ...change }), false)
    }
  }
})
