import test from 'node:test'
import assert from 'node:assert/strict'
import { createDocumentLifecycleStore, documentLifecycleKey, lockDocumentLifecycleRecord } from './documentLifecycleStore.js'

function fixture() {
  const values = new Map()
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  }
  const page = (account = 'owner', service = '/api') => createDocumentLifecycleStore({
    key: documentLifecycleKey({ account, service }),
    storage: () => storage,
    withLock: (_, action) => action(),
  })
  return { storage, page }
}

test('a replacement page can read the original target, scoped to account and service', () => {
  const { page } = fixture()
  const raw = page().prepare({ id: 8, operation: 'restore', title: 'private title', token: 'secret' })
  const { id, operation, ...metadata } = page().read().target
  assert.equal(id, 8)
  assert.equal(operation, 'restore')
  assert.deepEqual(Object.keys(metadata), ['attemptId'])
  assert.equal(page('peer').read(), null)
  assert.equal(page('owner', 'http://other/api').read(), null)
  assert.equal(page().prepare({ id: 9, operation: 'delete' }), null)
  assert.equal(page().read().raw, raw)
})

test('a stale action cannot clear a newer attempt on the very same document', () => {
  const { page } = fixture()
  const target = { id: 8, operation: 'delete' }
  const first = page().prepare(target)
  assert.equal(page().clear(first), true)
  const second = page().prepare(target)
  assert.notEqual(first, second)
  assert.equal(page().clear(first), false)
  assert.equal(page().read().raw, second)
})

test('damaged records are preserved until the caller explicitly clears that record', () => {
  const { storage, page } = fixture()
  const key = documentLifecycleKey({ account: 'owner', service: '/api' })
  storage.setItem(key, 'malformed')
  assert.deepEqual(page().read(), { raw: 'malformed', target: null })
  assert.equal(page().prepare({ id: 8, operation: 'restore' }), null)
  assert.equal(page().clear('older value'), false)
  assert.equal(page().clear('malformed'), true)
})

test('a storage write that silently fails cannot prepare a network operation', () => {
  const { storage, page } = fixture()
  storage.setItem = () => {}
  assert.throws(() => page().prepare({ id: 8, operation: 'delete' }), /未能保存/)
})

test('an immediate Web Lock uses compatible options and never starts work when held elsewhere', async () => {
  let held = false
  const locks = { async request(key, options, action) {
    assert.equal(key, 'scope')
    assert.deepEqual(options, { ifAvailable: true })
    if (held) return action(null)
    held = true
    try { return await action({ name: key }) } finally { held = false }
  } }
  const first = lockDocumentLifecycleRecord('scope', async () => {
    await assert.rejects(lockDocumentLifecycleRecord('scope', () => assert.fail('unexpected write'), locks), /另一个页面/)
    return 'done'
  }, locks)
  assert.equal(await first, 'done')
  assert.equal(await lockDocumentLifecycleRecord('scope', () => 'next', locks), 'next')
})
