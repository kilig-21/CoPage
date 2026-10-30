import test from 'node:test'
import assert from 'node:assert/strict'
import { createGroupSession, isGroupSessionFailure } from './groupSession.js'

const original = { account: 'synthetic-A', token: 'token-A', service: '/api' }
const changed = failure => isGroupSessionFailure(failure) && failure.reason === 'GROUP_SESSION_CHANGED'
const unavailable = failure => isGroupSessionFailure(failure) && failure.reason === 'GROUP_SESSION_UNAVAILABLE'
function fixture() {
  let identity = { ...original }, denied = false
  const session = createGroupSession({ readIdentity: () => {
    if (denied) throw new Error('storage unavailable')
    return identity
  } })
  return { session, change: patch => { identity = { ...identity, ...patch } }, deny: () => { denied = true } }
}
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('小组列表、收到的邀请及详情读取都使用同一原会话，保持各自响应和取消信号', async () => {
  const f = fixture(), controller = new AbortController(), calls = []
  for (const path of ['/groups', '/groups/invitations', '/groups/3']) {
    const response = { data: { resource: path } }
    assert.equal(await f.session.run(controller.signal, config => {
      calls.push({ path, config })
      return response
    }), response)
  }
  assert.deepEqual(calls.map(item => item.path), ['/groups', '/groups/invitations', '/groups/3'])
  for (const { config } of calls) {
    assert.equal(config.signal, controller.signal)
    assert.equal(config.copageExpectedSessionToken, 'token-A')
  }
  assert.deepEqual(f.session.identity, original)
  assert.equal(Object.isFrozen(f.session.identity), true)
})

for (const [label, patch] of [
  ['令牌变化', { token: 'token-B' }],
  ['仅账号名变化', { account: 'synthetic-B' }],
  ['服务变化', { service: 'https://another.invalid/api' }],
  ['退出登录', { token: null }],
]) test(label + '发生在发送前时，三类读取和写入回调均不执行，也不改绑原身份', async () => {
  const f = fixture(), calls = []
  f.change(patch)
  for (const resource of ['groups', 'inbox', 'detail', 'invite']) {
    await assert.rejects(f.session.run(undefined, () => { calls.push(resource) }), changed)
  }
  assert.deepEqual(calls, [])
  assert.equal(f.session.isCurrent(), false)
  assert.deepEqual(f.session.identity, original)
})

test('发送前存储不可读有独立原因，不能执行回调或把未知身份当原账号', async () => {
  const f = fixture()
  f.deny()
  await assert.rejects(f.session.run(undefined, () => assert.fail('不应发送')), unavailable)
  assert.throws(() => f.session.assertCurrent(), unavailable)
  assert.equal(f.session.isCurrent(), false)
})

test('模拟原A邀请已提交但回复到达前切为B时，不接受为B成功、不重发，保留稳定原归属', async () => {
  const f = fixture(), reply = deferred(), ledger = [], controller = new AbortController()
  let calls = 0
  const result = f.session.run(controller.signal, config => {
    calls++
    ledger.push({ groupId: 3, recipient: 1, actor: config.copageExpectedSessionToken })
    return reply.promise
  })
  f.change({ account: 'synthetic-B', token: 'token-B' })
  reply.resolve({ data: null })
  await assert.rejects(result, changed)
  assert.equal(calls, 1)
  assert.deepEqual(ledger, [{ groupId: 3, recipient: 1, actor: 'token-A' }])
  assert.deepEqual(f.session.identity, original)
})

test('三类原A读取的迟到成功均不能作为B当前小组资料返回', async () => {
  for (const resource of ['groups', 'inbox', 'detail']) {
    const f = fixture(), reply = deferred()
    const result = f.session.run(undefined, () => reply.promise)
    f.change({ token: 'token-B' })
    reply.resolve({ data: { resource, privateTo: 'synthetic-A' } })
    await assert.rejects(result, changed)
  }
})

test('原请求失败时已切换账号，优先停止旧会话，不把A业务拒绝或超时交给B处理', async () => {
  for (const failure of [Object.freeze({ code: 403, message: 'original A rejected' }), new Error('timeout')]) {
    const f = fixture(), reply = deferred()
    const result = f.session.run(undefined, () => reply.promise)
    f.change({ account: 'synthetic-B', token: 'token-B' })
    reply.reject(failure)
    await assert.rejects(result, changed)
  }
})

test('回复前服务变化或存储不可读时不接受旧成功，不能仅核对令牌', async () => {
  for (const mode of ['service', 'storage']) {
    const f = fixture(), reply = deferred()
    const result = f.session.run(undefined, () => reply.promise)
    if (mode === 'storage') f.deny()
    else f.change({ service: 'https://another.invalid/api' })
    reply.resolve({ data: { id: 3 } })
    await assert.rejects(result, mode === 'storage' ? unavailable : changed)
  }
})

test('同身份普通503保留原错误，之后主动读取仍用原身份，无自动重发', async () => {
  const f = fixture(), failure = Object.freeze({ code: 503, message: 'temporary outage' }), calls = []
  await assert.rejects(f.session.run(undefined, config => {
    calls.push(['write', config.copageExpectedSessionToken])
    throw failure
  }), error => error === failure)
  assert.equal(f.session.isCurrent(), true)
  const response = { data: { id: 3, members: [3, 4] } }
  assert.equal(await f.session.run(undefined, config => {
    calls.push(['review', config.copageExpectedSessionToken])
    return response
  }), response)
  assert.deepEqual(calls, [['write', 'token-A'], ['review', 'token-A']])
})

test('取消前不发送，取消在途操作后不把已完成结果返回；取消不冒充身份变化', async () => {
  const f = fixture(), controller = new AbortController()
  controller.abort()
  await assert.rejects(f.session.run(controller.signal, () => assert.fail('不应发送')),
    error => error.name === 'AbortError' && !isGroupSessionFailure(error))
  const active = new AbortController(), reply = deferred()
  const result = f.session.run(active.signal, () => reply.promise)
  active.abort(); reply.resolve({ data: null })
  await assert.rejects(result, error => error.name === 'AbortError' && !isGroupSessionFailure(error))
})

test('最初身份不可读或缺失时拒绝建立可重绑的会话', () => {
  assert.throws(() => createGroupSession({ readIdentity: () => { throw Error('denied') } }), unavailable)
  for (const identity of [null, { ...original, token: null }, { ...original, account: '' }, { ...original, service: '' }]) {
    assert.throws(() => createGroupSession({ readIdentity: () => identity }), changed)
  }
  assert.equal(isGroupSessionFailure(new Error('ordinary failure')), false)
})
