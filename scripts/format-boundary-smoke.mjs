import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const origin = process.env.COPAGE_FORMAT_ORIGIN || 'http://localhost:8080'
const sockets = []
const ids = []
let token
const marker = 'FormatBoundary-' + randomUUID()
async function api(path, method = 'GET', body) {
  const form = body instanceof FormData
  const response = await fetch(origin + '/api' + path, {
    method, signal: AbortSignal.timeout(5000),
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(!form && body ? { 'Content-Type': 'application/json' } : {}) },
    body: form ? body : body ? JSON.stringify(body) : undefined,
  })
  const payload = await response.json()
  assert.equal(response.status, 200, payload.message)
  assert.equal(payload.code, 0, payload.message)
  return payload.data
}
async function connect() {
  const ws = new WebSocket(origin.replace(/^http/, 'ws') + '/ws/collab?token=' + encodeURIComponent(token))
  sockets.push(ws)
  const messages = []
  ws.addEventListener('message', e => messages.push(JSON.parse(e.data)))
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS handshake timeout')), 5000)
    ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WS handshake failed')) }, { once: true })
  })
  return async payload => {
    const after = messages.length
    ws.send(JSON.stringify(payload))
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const reply = messages.slice(after).find(m => ['ack', 'sync', 'error'].includes(m.type))
      if (reply) return reply
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error('WS reply timeout')
  }
}
try {
  token = (await api('/auth/login', 'POST', {
    username: process.env.COPAGE_FORMAT_USER || 'testA',
    password: process.env.COPAGE_FORMAT_PASSWORD || '123456',
  })).token
  const doc = await api('/doc', 'POST', { title: marker })
  ids.push(doc.id)
  const clientId = randomUUID()
  const send = await connect()
  assert.equal((await send({ type: 'join', docId: doc.id, clientId, lastRevision: 0, syncId: randomUUID() })).type, 'sync')
  const invalid = [
    { insert: { unsupported: 'qa' } }, { insert: { video: 'https://example.invalid/video' } },
    { insert: { formula: 'x' } }, { insert: { image: 'javascript:alert(1)' } },
    { insert: 'x', attributes: { link: 'javascript:alert(1)' } },
    { insert: 'x', attributes: { unsupported: true } }, { retain: 1.5 }, { delete: '1' },
  ]
  for (const op of invalid) {
    const reply = await send({ type: 'op', docId: doc.id, clientId, baseRevision: 0, opId: randomUUID(), op: { ops: [op] } })
    assert.equal(reply.type, 'error')
    assert.equal(reply.code, 400)
    assert.equal((await api('/doc/' + doc.id)).revision, 0, '拒绝操作不得改变正文版本')
  }
  const rich = { ops: [{ insert: '粗体😀', attributes: { bold: true } },
    { insert: { image: 'http://localhost:9000/collab/format-fixture.png' },
      attributes: { width: '64', height: '64', alt: '格式验收图片' } }] }
  assert.equal((await send({ type: 'op', docId: doc.id, clientId, baseRevision: 0, opId: randomUUID(), op: rich })).revision, 1)
  const remove = { ops: [{ retain: 4, attributes: { bold: null, underline: true } }] }
  assert.equal((await send({ type: 'op', docId: doc.id, clientId, baseRevision: 1, opId: randomUUID(), op: remove })).revision, 2)
  const current = await api('/doc/' + doc.id)
  assert.deepEqual(current.content.ops[0], { insert: '粗体😀', attributes: { underline: true } })
  const copy = await api(`/doc/${doc.id}/export?format=copage`)
  const form = new FormData()
  form.append('file', new File([copy.content], copy.filename, { type: 'application/json' }))
  const imported = await api('/doc/import', 'POST', form)
  ids.push(imported.id)
  assert.deepEqual((await api('/doc/' + imported.id)).content, current.content)
  const reconnect = await connect()
  const badPending = await reconnect({ type: 'join', docId: doc.id, clientId, lastRevision: 0,
    syncId: randomUUID(), pendingOpId: randomUUID(), pendingBaseRevision: 0,
    pendingOp: { ops: [{ insert: { unsupported: 'qa' } }] } })
  assert.equal(badPending.type, 'error')
  assert.equal(badPending.code, 400)
  assert.equal((await api('/doc/' + doc.id)).revision, 2)
  console.log(JSON.stringify({ docIds: ids, invalidRejected: invalid.length, revisionUnchangedOnReject: true,
    formatRemoval: true, richExportImport: true, invalidPendingRejected: true }))
} finally {
  for (const ws of sockets) ws.close()
  for (const id of ids) {
    const doc = await api('/doc/' + id)
    assert.ok(doc.isOwner && doc.title.startsWith(marker), '清理前必须核对本轮合成文档')
    await api('/doc/' + id, 'DELETE')
  }
}
