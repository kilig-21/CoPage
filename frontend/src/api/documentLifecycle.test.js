import test from 'node:test'
import assert from 'node:assert/strict'
import { confirmDocumentDeletion, parseDocumentRestoration, parseDocumentState } from './documentLifecycle.js'

const doc = { id: 7, title: '找回我的资料' }

test('normal delete, restore and both current states follow the backend contract', () => {
  assert.doesNotThrow(() => confirmDocumentDeletion({ code: 0, data: null }))
  assert.equal(parseDocumentRestoration({ code: 0, data: doc }, 7), doc)
  for (const deleted of [true, false]) {
    const data = { ...doc, deleted }
    assert.equal(parseDocumentState({ code: 0, data }, 7), data)
  }
})

test('HTTP 200 carrying a business failure cannot confirm any lifecycle result', () => {
  for (const code of [500, 400, 401, 403, 404, '0', null, undefined]) {
    assert.throws(() => confirmDocumentDeletion({ code, data: null }))
    assert.throws(() => parseDocumentRestoration({ code, data: doc }, 7))
    assert.throws(() => parseDocumentState({ code, data: { ...doc, deleted: false } }, 7))
  }
})

test('missing or malformed envelopes and deletion payloads remain unconfirmed', () => {
  for (const value of [null, undefined, [], 'success', {}, { code: 0 }, { code: 0, data: {} }]) {
    assert.throws(() => confirmDocumentDeletion(value))
    assert.throws(() => parseDocumentRestoration(value, 7))
    assert.throws(() => parseDocumentState(value, 7))
  }
})

test('a same-title reply for another document cannot release the original target', () => {
  for (const id of [8, '7', 0, -1, 1.5, null, undefined]) {
    assert.throws(() => parseDocumentRestoration({ code: 0, data: { ...doc, id } }, 7))
    assert.throws(() => parseDocumentState({ code: 0, data: { ...doc, id, deleted: false } }, 7))
  }
  for (const expected of [0, -1, 1.5, '7', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseDocumentRestoration({ code: 0, data: { ...doc, id: expected } }, expected))
  }
})

test('incomplete titles cannot produce success feedback or an open-document action', () => {
  for (const title of ['', '  ', 7, null, undefined, '长'.repeat(201)]) {
    assert.throws(() => parseDocumentRestoration({ code: 0, data: { ...doc, title } }, 7))
    assert.throws(() => parseDocumentState({ code: 0, data: { ...doc, title, deleted: false } }, 7))
  }
})

test('state review requires a real boolean instead of coercing a deleted marker', () => {
  for (const deleted of ['false', 'true', 0, 1, null, undefined]) {
    assert.throws(() => parseDocumentState({ code: 0, data: { ...doc, deleted } }, 7))
  }
})
