import test from 'node:test'
import assert from 'node:assert/strict'
import { safeReturnPath, expireSession } from './session.js'

test('login only returns to supported internal pages', () => {
  assert.equal(safeReturnPath('/docs/60'), '/docs/60')
  assert.equal(safeReturnPath('/search?q=meeting&page=2'), '/search?q=meeting&page=2')
  assert.equal(safeReturnPath('/templates'), '/templates')
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
