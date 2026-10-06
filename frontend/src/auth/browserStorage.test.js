import test from 'node:test'
import assert from 'node:assert/strict'
import { canReadBrowserStorage } from './browserStorage.js'

test('入口探测只读存储，不清除已有身份、草稿或标签记录', () => {
  const local = new Map([['collab-token', 'test-token'], ['collab-user', 'testB'],
    ['copage-draft:v1:testB:221:old', 'unconfirmed-draft']])
  const session = new Map([['copage-tab-client:221', 'old-client']])
  const forbiddenWrite = () => { throw new Error('探测不应写入或删除') }
  const adapter = data => ({ getItem: key => data.get(key) ?? null, setItem: forbiddenWrite,
    removeItem: forbiddenWrite, clear: forbiddenWrite })
  assert.equal(canReadBrowserStorage({ localStorage: adapter(local), sessionStorage: adapter(session) }), true)
  assert.equal(local.get('copage-draft:v1:testB:221:old'), 'unconfirmed-draft')
  assert.equal(local.get('collab-token'), 'test-token')
  assert.equal(session.get('copage-tab-client:221'), 'old-client')
})

test('拒绝存储对象或读取时返回不可用，解除拒绝后可重新探测', () => {
  for (const blocked of ['localStorage', 'sessionStorage']) {
    for (const stage of ['access', 'read']) {
      let denied = true
      const readable = { getItem: () => null }
      const browser = { localStorage: readable, sessionStorage: readable }
      Object.defineProperty(browser, blocked, { get() {
        if (denied && stage === 'access') throw new DOMException('storage denied', 'SecurityError')
        return { getItem: () => {
          if (denied) throw new DOMException('storage denied', 'SecurityError')
          return null
        } }
      } })
      assert.equal(canReadBrowserStorage(browser), false)
      denied = false
      assert.equal(canReadBrowserStorage(browser), true)
    }
  }
})
