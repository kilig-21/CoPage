import test from 'node:test'
import assert from 'node:assert/strict'
import { safeReturnPath, captureLoginIdentity, saveSession, logoutSession, expireSession, subscribeSessionChanges, createReconnectSessionCheck } from './session.js'

test('login only returns to supported internal pages', () => {
  assert.equal(safeReturnPath('/docs/60'), '/docs/60')
  assert.equal(safeReturnPath('/search?q=meeting&page=2'), '/search?q=meeting&page=2')
  assert.equal(safeReturnPath('/projects?project=5&groupId=3'), '/projects?project=5&groupId=3')
  assert.equal(safeReturnPath('/projects/../../login'), '/docs')
  assert.equal(safeReturnPath('/groups?group=3'), '/groups?group=3')
  assert.equal(safeReturnPath('/groups/../../login'), '/docs')
  assert.equal(safeReturnPath('/home'), '/home')
  assert.equal(safeReturnPath('/home/../../login'), '/docs')
  assert.equal(safeReturnPath('/templates'), '/templates')
  assert.equal(safeReturnPath('/trash'), '/trash')
  assert.equal(safeReturnPath('/account'), '/account')
  for (const path of ['https://example.com', '//example.com', '/login', '/docs/../../login', null]) {
    assert.equal(safeReturnPath(path), '/docs')
  }
})

test('expired session preserves drafts and late errors cannot clear a newer login', () => {
  const data = new Map([['collab-token', 'new'], ['collab-user', 'testA'], ['copage-draft:v1:testA:60:x', 'saved']])
  const storage = { getItem: key => data.get(key), removeItem: key => data.delete(key) }
  let notifications = 0
  assert.equal(expireSession(storage, 'old', () => notifications++), false)
  assert.equal(data.get('collab-token'), 'new')
  assert.equal(expireSession(storage, 'new', () => notifications++), true)
  assert.equal(notifications, 1)
  assert.equal(data.get('copage-draft:v1:testA:60:x'), 'saved')
  assert.equal(expireSession(storage, 'new', () => notifications++), false)
  assert.equal(notifications, 1)
})

test('other-tab logout and account changes notify once without changing tokens or drafts', () => {
  const data = new Map([['collab-token', 'account-A'], ['copage-draft:v1:testA:212:x', 'saved']])
  const storage = { getItem: key => data.get(key) ?? null }
  const events = new EventTarget()
  let notifications = 0
  const stop = subscribeSessionChanges(storage, events, () => notifications++)
  const emit = (key, storageArea = storage) => events.dispatchEvent(Object.assign(new Event('storage'), { key, storageArea }))
  emit('copage-draft:v1:testA:212:x')
  data.delete('collab-token')
  emit('collab-token', {})
  assert.equal(notifications, 0)
  emit('collab-token')
  emit('collab-token')
  assert.equal(notifications, 1)
  data.set('collab-token', 'account-B')
  emit('collab-token')
  assert.equal(notifications, 2)
  assert.equal(data.get('collab-token'), 'account-B')
  assert.equal(data.get('copage-draft:v1:testA:212:x'), 'saved')
  stop()
  data.delete('collab-token')
  emit(null)
  assert.equal(notifications, 2)
})

test('storage clear notifies and stale queued events use the current session', () => {
  let token = 'A', notifications = 0
  const storage = { getItem: () => token }
  const events = new EventTarget()
  const stop = subscribeSessionChanges(storage, events, () => notifications++)
  const emit = key => events.dispatchEvent(Object.assign(new Event('storage'), { key, storageArea: storage, oldValue: 'A', newValue: 'B' }))
  token = 'A' // 另一页面先改成B又改回A；迟到事件不应中断当前会话。
  emit('collab-token')
  assert.equal(notifications, 0)
  token = null
  emit(null)
  assert.equal(notifications, 1)
  stop()
})

test('reconnect only expires a current session confirmed unauthorized', async () => {
  let expired = 0
  for (const status of [200, 403, 404, 500, 503]) {
    await createReconnectSessionCheck({ getStatus: async () => status,
      isCurrent: () => true, onExpired: () => expired++ })()
  }
  await createReconnectSessionCheck({ getStatus: async () => { throw new Error('offline') },
    isCurrent: () => true, onExpired: () => expired++ })()
  assert.equal(expired, 0)
  await createReconnectSessionCheck({ getStatus: async () => 401,
    isCurrent: () => true, onExpired: () => expired++ })()
  assert.equal(expired, 1)
})

test('reconnect checks coalesce and ignore late unauthorized results after session change or unmount', async () => {
  let resolveStatus, calls = 0, expired = 0, current = true
  const check = createReconnectSessionCheck({ getStatus: () => { calls++; return new Promise(resolve => { resolveStatus = resolve }) },
    isCurrent: () => current, onExpired: () => expired++ })
  const first = check(), second = check()
  assert.equal(first, second)
  await Promise.resolve()
  assert.equal(calls, 1)
  current = false
  resolveStatus(401)
  await first
  await check()
  assert.equal(expired, 0)
  assert.equal(calls, 1)
  current = true
  const next = check()
  await Promise.resolve()
  assert.equal(calls, 2)
  resolveStatus(401)
  await next
  assert.equal(expired, 1)
})

test('登录成功提交完整身份，写入过程不留下可用于读取错误账号草稿的令牌', () => {
  const data = new Map([['collab-token', 'old-B'], ['collab-user', 'testB'],
    ['copage-draft:v1:testB:220:old', 'original-B-draft']])
  const identities = new Map([['old-B', 'testB'], ['new-A', 'testA']])
  const check = () => {
    const token = data.get('collab-token')
    if (token) assert.equal(data.get('collab-user'), identities.get(token))
    assert.equal(data.get('copage-draft:v1:testB:220:old'), 'original-B-draft')
  }
  const storage = {
    removeItem: key => { data.delete(key); check() },
    setItem: (key, value) => { data.set(key, value); check() },
  }
  saveSession(storage, { token: 'new-A', username: 'testA' })
  assert.equal(data.get('collab-token'), 'new-A')
  assert.equal(data.get('collab-user'), 'testA')
})

test('旧登录正常回复在会话通知尚未处理时也不能覆盖另一标签的新登录', async () => {
  const data = new Map([['copage-draft:v1:testA:26:x', 'draft-A'], ['copage-draft:v1:testB:26:y', 'draft-B']])
  let writes = 0, deliver
  const storage = { getItem: key => data.get(key) ?? null,
    removeItem: key => { writes++; data.delete(key) }, setItem: (key, value) => { writes++; data.set(key, value) } }
  const expectedIdentity = captureLoginIdentity(storage)
  const oldReply = new Promise(resolve => { deliver = resolve }).then(response => saveSession(storage, response, { expectedIdentity }))
  // 另一标签先完成B登录；本页尚未收到任何storage通知，原A请求也未被abort。
  saveSession(storage, { token: 'new-B', username: 'testB' })
  const before = [...data]; writes = 0
  deliver({ token: 'late-A', username: 'testA' })
  await assert.rejects(oldReply, /登录状态已在其他页面更改/)
  assert.equal(writes, 0); assert.deepEqual([...data], before)
})

test('登录身份快照冻结原两字段，兼容未登录及退出后残留用户名，不随存储改变', () => {
  for (const initial of [[], [['collab-user', 'old-user']], [['collab-token', 'A'], ['collab-user', 'testA']]]) {
    const data = new Map(initial), storage = { getItem: key => data.get(key) ?? null }
    const expected = { token: data.get('collab-token') ?? null, username: data.get('collab-user') ?? null }
    const snapshot = captureLoginIdentity(storage)
    assert.deepEqual(snapshot, expected); assert.equal(Object.isFrozen(snapshot), true)
    data.set('collab-token', 'B'); data.set('collab-user', 'testB')
    assert.deepEqual(snapshot, expected)
    assert.throws(() => { snapshot.username = 'replaced' }, TypeError)
  }
})

test('原身份未变时expectedIdentity正常提交新会话，仅按既有顺序写两个身份键', () => {
  for (const initial of [[], [['collab-user', 'old-user']], [['collab-token', 'A'], ['collab-user', 'testA']]]) {
    const data = new Map([...initial, ['copage-draft:v1:testA:26:x', 'draft-A']]), writes = []
    const storage = { getItem: key => data.get(key) ?? null,
      removeItem: key => { writes.push(['remove', key]); data.delete(key) },
      setItem: (key, value) => { writes.push(['set', key, value]); data.set(key, value) } }
    const snapshot = captureLoginIdentity(storage)
    saveSession(storage, { token: 'new-B', username: 'testB' }, { expectedIdentity: snapshot })
    assert.deepEqual(writes, [['remove', 'collab-token'], ['set', 'collab-user', 'testB'], ['set', 'collab-token', 'new-B']])
    assert.equal(data.get('collab-token'), 'new-B'); assert.equal(data.get('collab-user'), 'testB')
    assert.equal(data.get('copage-draft:v1:testA:26:x'), 'draft-A')
  }
})

test('用户名单字段变化、同账号新令牌或退出后token缺失均拒绝旧回复且零写', () => {
  for (const change of [data => data.set('collab-user', 'testB'), data => data.set('collab-token', 'new-A'),
    data => data.delete('collab-token'), data => { data.delete('collab-token'); data.delete('collab-user') }]) {
    const data = new Map([['collab-token', 'A'], ['collab-user', 'testA'], ['draft-A', 'draft-A'], ['draft-B', 'draft-B']])
    let writes = 0
    const storage = { getItem: key => data.get(key) ?? null, removeItem: key => { writes++; data.delete(key) },
      setItem: (key, value) => { writes++; data.set(key, value) } }
    const snapshot = captureLoginIdentity(storage)
    change(data); const before = [...data]
    assert.throws(() => saveSession(storage, { token: 'late-A', username: 'testA' }, { expectedIdentity: snapshot }), /登录状态已在其他页面更改/)
    assert.equal(writes, 0); assert.deepEqual([...data], before)
  }
})

test('捕获或提交前任一身份字段读取失败时中文拒绝，不移除令牌或修改草稿', () => {
  for (const field of ['collab-token', 'collab-user']) {
    const data = new Map([['collab-token', 'B'], ['collab-user', 'testB'], ['draft-B', 'saved']])
    let blocked = false, writes = 0
    const storage = { getItem: key => { if (blocked && key === field) throw new DOMException('blocked', 'SecurityError'); return data.get(key) ?? null },
      removeItem: key => { writes++; data.delete(key) }, setItem: (key, value) => { writes++; data.set(key, value) } }
    const snapshot = captureLoginIdentity(storage), before = [...data]
    blocked = true
    assert.throws(() => captureLoginIdentity(storage), /无法读取当前登录状态.*身份和草稿未改动/)
    assert.throws(() => saveSession(storage, { token: 'late-A', username: 'testA' }, { expectedIdentity: snapshot }), /无法读取当前登录状态/)
    assert.equal(writes, 0); assert.deepEqual([...data], before)
    blocked = false
    saveSession(storage, { token: 'new-A', username: 'testA' }, { expectedIdentity: snapshot })
    assert.equal(data.get('collab-token'), 'new-A'); assert.equal(data.get('draft-B'), 'saved')
  }
})

test('expectedIdentity不可识别时拒绝写入；新登录信息仍优先验证', () => {
  let reads = 0, writes = 0
  const storage = { getItem: () => { reads++; throw Error('blocked') }, removeItem: () => writes++, setItem: () => writes++ }
  for (const expectedIdentity of [null, {}, [], { token: null }, { token: 1, username: null },
    { token: null, username: null, extra: true }]) {
    assert.throws(() => saveSession(storage, { token: 'A', username: 'testA' }, { expectedIdentity }), /账号状态无法确认/)
  }
  assert.throws(() => saveSession(storage, { token: '', username: 'testA' }, {
    expectedIdentity: Object.freeze({ token: null, username: null }),
  }), /登录信息不完整/)
  assert.equal(reads, 0); assert.equal(writes, 0)
})

test('登录保存各步骤失败时身份仍一致，草稿不变且解除失败后可重试', () => {
  for (const failingStep of ['remove-token', 'write-user', 'write-token']) {
    const data = new Map([['collab-token', 'old-B'], ['collab-user', 'testB'],
      ['copage-draft:v1:testB:220:old', 'original-B-draft']])
    let failureEnabled = true
    const fail = step => {
      if (failureEnabled && step === failingStep) throw new DOMException('storage unavailable', 'QuotaExceededError')
    }
    const storage = {
      removeItem: key => { fail('remove-token'); data.delete(key) },
      setItem: (key, value) => { fail(key === 'collab-user' ? 'write-user' : 'write-token'); data.set(key, value) },
    }
    assert.throws(() => saveSession(storage, { token: 'new-A', username: 'testA' }), /无法保存登录信息.*草稿仍保留/)
    const token = data.get('collab-token')
    assert.ok(token === undefined || (token === 'old-B' && data.get('collab-user') === 'testB'))
    assert.equal(data.get('copage-draft:v1:testB:220:old'), 'original-B-draft')
    failureEnabled = false
    saveSession(storage, { token: 'new-A', username: 'testA' })
    assert.equal(data.get('collab-token'), 'new-A')
    assert.equal(data.get('collab-user'), 'testA')
    assert.equal(data.get('copage-draft:v1:testB:220:old'), 'original-B-draft')
  }
})

test('不完整的登录响应在修改现有身份之前拒绝', () => {
  for (const response of [{ token: '', username: 'testA' }, { token: 'new-A' },
    { token: 'new-A', username: ' ' }, { token: 42, username: 'testA' }]) {
    let writes = 0
    const storage = { removeItem: () => writes++, setItem: () => writes++ }
    assert.throws(() => saveSession(storage, response), /登录信息不完整/)
    assert.equal(writes, 0)
  }
})

test('主动退出只移除身份键，保留两个账号的草稿和客户端标识', () => {
  const data = new Map([['collab-token', 'A'], ['collab-user', 'testA'],
    ['copage-draft:v1:testA:377:x', 'draft-A'], ['copage-draft:v1:testB:378:y', 'draft-B'],
    ['copage-client-id', 'client']])
  const removed = []
  assert.deepEqual(logoutSession({ removeItem: key => { removed.push(key); data.delete(key) } }), { usernameCleared: true })
  assert.deepEqual(removed, ['collab-token', 'collab-user'])
  assert.deepEqual([...data], [['copage-draft:v1:testA:377:x', 'draft-A'],
    ['copage-draft:v1:testB:378:y', 'draft-B'], ['copage-client-id', 'client']])
})

test('退出无法清除令牌时不删账号名、不假称成功，解除失败后可重试', () => {
  const data = new Map([['collab-token', 'A'], ['collab-user', 'testA'], ['copage-draft:v1:testA:377:x', 'draft']])
  let blocked = true
  const storage = { removeItem: key => {
    if (blocked && key === 'collab-token') throw new DOMException('blocked', 'SecurityError')
    data.delete(key)
  } }
  assert.throws(() => logoutSession(storage), /无法清除登录信息.*草稿仍保留/)
  assert.equal(data.get('collab-token'), 'A')
  assert.equal(data.get('collab-user'), 'testA')
  assert.equal(data.get('copage-draft:v1:testA:377:x'), 'draft')
  blocked = false
  assert.deepEqual(logoutSession(storage), { usernameCleared: true })
  assert.equal(data.get('copage-draft:v1:testA:377:x'), 'draft')
})

test('退出已清除令牌但账号名失败仍无登录，后续新登录身份正确且原草稿不变', () => {
  const data = new Map([['collab-token', 'A'], ['collab-user', 'testA'], ['copage-draft:v1:testA:377:x', 'draft']])
  const storage = {
    removeItem: key => { if (key === 'collab-user') throw new DOMException('blocked', 'SecurityError'); data.delete(key) },
    setItem: (key, value) => data.set(key, value),
  }
  assert.deepEqual(logoutSession(storage), { usernameCleared: false })
  assert.equal(data.has('collab-token'), false)
  assert.equal(data.get('collab-user'), 'testA')
  saveSession(storage, { token: 'B', username: 'testB' })
  assert.equal(data.get('collab-token'), 'B')
  assert.equal(data.get('collab-user'), 'testB')
  assert.equal(data.get('copage-draft:v1:testA:377:x'), 'draft')
})

test('确认失效后账号名清理失败仍通知登录页，原草稿保持', () => {
  const data = new Map([['collab-token', 'A'], ['collab-user', 'testA'], ['draft-A', 'saved']])
  let result
  const storage = { getItem: key => data.get(key), removeItem: key => {
    if (key === 'collab-user') throw new DOMException('blocked', 'SecurityError')
    data.delete(key)
  } }
  assert.equal(expireSession(storage, 'A', value => { result = value }), true)
  assert.deepEqual(result, { tokenCleared: true, usernameCleared: false, cleanupFailed: true })
  assert.equal(data.has('collab-token'), false)
  assert.equal(data.get('collab-user'), 'testA')
  assert.equal(data.get('draft-A'), 'saved')
})

test('服务器确认失效但令牌删除失败仍反馈，不能冒称已清除', () => {
  const data = new Map([['collab-token', 'A'], ['collab-user', 'testA'], ['draft-A', 'saved']])
  let result
  const storage = { getItem: key => data.get(key), removeItem: () => { throw new DOMException('blocked', 'SecurityError') } }
  assert.equal(expireSession(storage, 'A', value => { result = value }), true)
  assert.deepEqual(result, { tokenCleared: false, usernameCleared: false, cleanupFailed: true })
  assert.deepEqual([...data], [['collab-token', 'A'], ['collab-user', 'testA'], ['draft-A', 'saved']])
})

test('较新登录存在时，失败清理逻辑也不能替旧请求退出新身份', () => {
  const storage = { getItem: () => 'B', removeItem: () => { throw new Error('must not clear B') } }
  let notified = false
  assert.equal(expireSession(storage, 'A', () => { notified = true }), false)
  assert.equal(notified, false)
})

test('无法确认当前登录身份时不清理或通知其它账号', () => {
  let removed = false, notified = false
  const storage = { getItem: () => { throw new DOMException('blocked', 'SecurityError') }, removeItem: () => { removed = true } }
  assert.throws(() => expireSession(storage, 'A', () => { notified = true }), /blocked/)
  assert.equal(removed, false)
  assert.equal(notified, false)
})
