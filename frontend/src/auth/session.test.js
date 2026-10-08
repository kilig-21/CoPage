import test from 'node:test'
import assert from 'node:assert/strict'
import { safeReturnPath, saveSession, expireSession, subscribeSessionChanges, createReconnectSessionCheck } from './session.js'

test('login only returns to supported internal pages', () => {
  assert.equal(safeReturnPath('/docs/60'), '/docs/60')
  assert.equal(safeReturnPath('/search?q=meeting&page=2'), '/search?q=meeting&page=2')
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
