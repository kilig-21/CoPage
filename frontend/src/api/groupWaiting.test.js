import test from 'node:test'
import assert from 'node:assert/strict'
import { createGroupWaiting } from './groupWaiting.js'

const pending = (extra = {}) => Object.freeze({ resource: 'detail', epoch: 2, target: 38, operation: '更新成员角色', ...extra })
function fixture() {
  let epoch = 2, blocked = false, identity = { account: 'owner', token: 'original-token', service: '/api' }, denied = false
  const waiting = createGroupWaiting({ readIdentity: () => { if (denied) throw Error('storage unavailable'); return identity },
    getEpoch: () => epoch, isBlocked: () => blocked })
  return { waiting, epoch: value => { epoch = value }, blocked: value => { blocked = value },
    identity: value => { identity = value }, denied: value => { denied = value } }
}
const detailRead = extra => ({ resource: 'detail', epoch: 2, target: 38, keyword: '', ...extra })
function failedReview(waiting, target, context = detailRead()) {
  assert.equal(waiting.requestReview(target), true)
  const read = waiting.startRead(context)
  assert.ok(read)
  waiting.finishRead(read, true)
}

test('原详情明确核对失败后才允许精确确认结束，结束不代表成功或发起任何写入', () => {
  const f = fixture(), target = pending()
  f.waiting.remember(target)
  assert.equal(f.waiting.endWaiting(target), false)
  const automatic = f.waiting.startRead(detailRead())
  f.waiting.finishRead(automatic, true)
  assert.equal(f.waiting.snapshot().reviewFailed, false)
  assert.equal(f.waiting.endWaiting(target), false)
  failedReview(f.waiting, target)
  assert.equal(f.waiting.snapshot().reviewFailed, true)
  assert.equal(f.waiting.endWaiting({ ...target }), false)
  assert.equal(f.waiting.endWaiting(target), true)
  assert.deepEqual(f.waiting.snapshot(), { checking: false, reviewFailed: false })
  assert.equal(f.waiting.endWaiting(target), false)
})

test('写入期间旧读、其他资源、其他详情与错误代次不能提供结束依据', () => {
  const f = fixture(), target = pending()
  const beforeUnknown = f.waiting.startRead(detailRead({ epoch: 1 }))
  f.waiting.remember(target)
  f.waiting.finishRead(beforeUnknown, true)
  f.waiting.requestReview(target)
  for (const context of [detailRead({ resource: 'groups' }), detailRead({ target: 39 }), detailRead({ epoch: 1 })]) {
    const read = f.waiting.startRead(context)
    assert.equal(read, null)
    f.waiting.finishRead(read, true)
  }
  assert.equal(f.waiting.snapshot().reviewFailed, false)
  assert.equal(f.waiting.endWaiting(target), false)
  const actual = f.waiting.startRead(detailRead())
  f.waiting.finishRead(actual, true)
  assert.equal(f.waiting.endWaiting(target), true)
})

test('groups保留原关键词限制，inbox不误用当前选中的详情编号', () => {
  for (const resource of ['groups', 'inbox']) {
    const f = fixture(), target = pending({ resource, target: 41, keyword: resource === 'groups' ? '原名称' : undefined })
    f.waiting.remember(target)
    f.waiting.requestReview(target)
    if (resource === 'groups') assert.equal(f.waiting.startRead({ resource, epoch: 2, keyword: '后来筛选' }), null)
    const read = f.waiting.startRead({ resource, epoch: 2, target: 0, keyword: '原名称' })
    f.waiting.finishRead(read, true)
    assert.equal(f.waiting.endWaiting(target), true)
  }
})

test('核对或任何原资源读取进行中，以及写/创建busy时，旧确认不能解除', () => {
  const f = fixture(), target = pending()
  f.waiting.remember(target); failedReview(f.waiting, target)
  const automatic = f.waiting.startRead(detailRead())
  assert.equal(f.waiting.endWaiting(target), false)
  f.waiting.finishRead(automatic, true)
  f.blocked(true)
  assert.equal(f.waiting.endWaiting(target), false)
  assert.equal(f.waiting.requestReview(target), false)
  f.blocked(false)
  assert.equal(f.waiting.requestReview(target), true)
  assert.equal(f.waiting.endWaiting(target), false)
  const review = f.waiting.startRead(detailRead())
  assert.equal(f.waiting.endWaiting(target), false)
  f.waiting.finishRead(review, true)
  assert.equal(f.waiting.endWaiting(target), true)
})

test('取消的显式核对不能提供失败依据，旧回调不能覆盖新核对', () => {
  const f = fixture(), target = pending()
  f.waiting.remember(target); f.waiting.requestReview(target)
  const old = f.waiting.startRead(detailRead())
  f.waiting.cancelRead(old); f.waiting.finishRead(old, true)
  assert.deepEqual(f.waiting.snapshot(), { checking: false, reviewFailed: false })
  f.waiting.requestReview(target)
  const next = f.waiting.startRead(detailRead())
  f.waiting.finishRead(old, true)
  assert.equal(f.waiting.snapshot().checking, true)
  assert.equal(f.waiting.endWaiting(target), false)
  f.waiting.finishRead(next, true)
  assert.equal(f.waiting.endWaiting(target), true)
})

test('账号/令牌/服务变化或存储失败不能结束原等待，恢复身份后须仍满足原对象与代次', () => {
  for (const mode of ['account', 'token', 'service', 'storage']) {
    const f = fixture(), target = pending()
    f.waiting.remember(target); failedReview(f.waiting, target)
    if (mode === 'storage') f.denied(true)
    else f.identity({ account: 'owner', token: 'original-token', service: '/api', [mode]: 'changed' })
    assert.equal(f.waiting.endWaiting(target), false)
    assert.equal(f.waiting.requestReview(target), false)
    f.denied(false); f.identity({ account: 'owner', token: 'original-token', service: '/api' })
    f.epoch(3); assert.equal(f.waiting.endWaiting(target), false)
    f.epoch(2); assert.equal(f.waiting.endWaiting(target), true)
  }
})

test('原目标成功新读仍可清等待；过期确认和旧读永不能解除后来未知目标', () => {
  const f = fixture(), original = pending()
  f.waiting.remember(original); failedReview(f.waiting, original)
  const old = f.waiting.startRead(detailRead())
  assert.equal(f.waiting.clear({ ...original }), false)
  assert.equal(f.waiting.clear(original), true)
  f.epoch(4)
  const next = pending({ epoch: 4, target: 39 })
  f.waiting.remember(next)
  f.waiting.finishRead(old, true)
  assert.equal(f.waiting.endWaiting(original), false)
  failedReview(f.waiting, next, detailRead({ epoch: 4, target: 39 }))
  assert.equal(f.waiting.endWaiting(original), false)
  assert.equal(f.waiting.endWaiting(next), true)
})

test('身份变化期间到达的失败不能提供结束依据，创建收据不进入该协调器', () => {
  const f = fixture(), target = pending()
  f.waiting.remember(target); f.waiting.requestReview(target)
  const read = f.waiting.startRead(detailRead())
  f.identity({ account: 'peer', token: 'peer-token', service: '/api' })
  f.waiting.finishRead(read, true)
  assert.equal(f.waiting.snapshot().reviewFailed, false)
  f.identity({ account: 'owner', token: 'original-token', service: '/api' })
  assert.equal(f.waiting.endWaiting(target), false)
  failedReview(f.waiting, target)
  const creation = pending({ kind: 'create' })
  assert.equal(f.waiting.remember(creation), false)
  assert.equal(f.waiting.endWaiting(creation), false)
  assert.equal(f.waiting.endWaiting(target), true)
})

test('显式意图后身份暂不可读，只有匹配读可撤销未开始意图，恢复后能重新核对', () => {
  const f = fixture(), target = pending()
  f.waiting.remember(target); f.waiting.requestReview(target); f.denied(true)
  assert.equal(f.waiting.startRead(detailRead({ resource: 'inbox' })), null)
  assert.equal(f.waiting.snapshot().checking, true)
  assert.equal(f.waiting.startRead(detailRead()), null)
  assert.equal(f.waiting.snapshot().checking, false)
  assert.equal(f.waiting.snapshot().reviewFailed, false)
  f.denied(false); failedReview(f.waiting, target)
  assert.equal(f.waiting.endWaiting(target), true)
})

test('取消未启动的显式意图只接受原对象，不清未知事实，旧取消不能影响新目标', () => {
  const f = fixture(), target = pending()
  f.waiting.remember(target); f.waiting.requestReview(target)
  assert.equal(f.waiting.cancelReview({ ...target }), false)
  assert.equal(f.waiting.snapshot().checking, true)
  assert.equal(f.waiting.cancelReview(target), true)
  assert.deepEqual(f.waiting.snapshot(), { checking: false, reviewFailed: false })
  assert.equal(f.waiting.endWaiting(target), false)
  f.epoch(4); const next = pending({ epoch: 4, target: 39 })
  f.waiting.remember(next); f.waiting.requestReview(next)
  assert.equal(f.waiting.cancelReview(target), false)
  assert.equal(f.waiting.snapshot().checking, true)
  assert.equal(f.waiting.cancelReview(next), true)
  failedReview(f.waiting, next, detailRead({ epoch: 4, target: 39 }))
  assert.equal(f.waiting.endWaiting(next), true)
})
