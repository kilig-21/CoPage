import assert from 'node:assert/strict'
import test from 'node:test'
import Delta from 'quill-delta'
import CollabClient from '../ws/CollabClient.js'
import { createDraftPersistence } from './draftPersistence.js'

test('burst input only writes the latest draft after 400 ms of quiet', ({ mock }) => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const saved = []
  let content = 'a'
  const drafts = createDraftPersistence(() => { saved.push(content); return true })
  drafts.schedule()
  mock.timers.tick(200)
  content = 'ab'
  drafts.schedule()
  mock.timers.tick(399)
  assert.deepEqual(saved, [])
  mock.timers.tick(1)
  assert.deepEqual(saved, ['ab'])
  mock.timers.tick(2000)
  assert.deepEqual(saved, ['ab'])
})

test('continuous input makes a backup at the maximum delay', ({ mock }) => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const saved = []
  let revision = 0
  const drafts = createDraftPersistence(() => { saved.push(revision); return true })
  for (let i = 0; i < 10; i++) {
    revision++
    drafts.schedule()
    mock.timers.tick(200)
  }
  assert.deepEqual(saved, [10])
  revision++
  drafts.schedule()
  mock.timers.tick(400)
  assert.deepEqual(saved, [10, 11])
})

test('a synchronous boundary flushes pending and buffered edits using the current draft state', ({ mock }) => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const client = new CollabClient({ docId: 1, clientId: 'draft-slot', Delta })
  let stored = null
  let writes = 0
  const content = new Delta().insert('断线前已输入\n')
  const drafts = createDraftPersistence(() => {
    const draft = client.exportDraft(content, { copy: false })
    stored = draft ? JSON.stringify(draft) : null
    writes++
    return true
  })
  client.submit(new Delta().insert('断线前'))
  drafts.schedule()
  client.submit(new Delta().retain(3).insert('已输入'))
  drafts.schedule()
  const pending = client.pending.opId
  assert.equal(stored, null)

  assert.equal(drafts.flush(), true)
  const saved = JSON.parse(stored)
  assert.equal(saved.pending.opId, pending)
  assert.deepEqual(saved.buffer.ops, [{ retain: 3 }, { insert: '已输入' }])
  assert.deepEqual(saved.content.ops, content.ops)
  assert.equal(drafts.flush(), true)
  mock.timers.tick(2000)
  assert.equal(writes, 1)

  client.pending = client.buffer = null
  drafts.schedule()
  assert.equal(drafts.flush(), true)
  assert.equal(stored, null)
  drafts.dispose()
})

test('failed writes stay dirty for a later boundary and dispose prevents a late write', ({ mock }) => {
  mock.timers.enable({ apis: ['setTimeout'] })
  let writable = false
  let attempts = 0
  const drafts = createDraftPersistence(() => { attempts++; return writable })
  drafts.schedule()
  mock.timers.tick(400)
  assert.equal(attempts, 1)
  assert.equal(drafts.flush(), false)
  writable = true
  assert.equal(drafts.flush(), true)
  assert.equal(attempts, 3)
  drafts.schedule()
  drafts.dispose()
  mock.timers.tick(2000)
  assert.equal(attempts, 3)
})

test('synchronous draft serialization borrows deltas while durable caller snapshots are still copied', () => {
  const client = new CollabClient({ docId: 1, clientId: 'draft-slot', Delta })
  client.submit(new Delta().insert('a'))
  client.submit(new Delta().retain(1).insert('b'))
  const content = new Delta().insert('ab\n')
  const draft = client.exportDraft(content, { copy: false })
  assert.equal(draft.content, content)
  assert.equal(draft.pending.original, client.pending.original)
  assert.equal(draft.buffer, client.buffer)
  const copied = client.exportDraft(content)
  assert.notEqual(copied.content, content)
  assert.notEqual(copied.pending.original, client.pending.original)
  assert.notEqual(copied.buffer, client.buffer)
})
