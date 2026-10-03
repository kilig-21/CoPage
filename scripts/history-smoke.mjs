import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const origin = process.env.COPAGE_HISTORY_ORIGIN || 'http://localhost:8081'
const peerOrigin = process.env.COPAGE_HISTORY_PEER_ORIGIN || origin
const sockets = []
let token, docId, memberId
async function api(path, method = 'GET', body, expected = 200, auth = token) {
  const response = await fetch(origin + '/api' + path, { method,
    headers: { ...(auth ? { Authorization: 'Bearer ' + auth } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body) })
  const result = await response.json()
  assert.equal(response.status, expected, `${method} ${path}: ${result.message}`)
  if (expected === 200) assert.equal(result.code, 0)
  return result.data
}
async function connect(base, auth, clientId) {
  const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws/collab?token=' + encodeURIComponent(auth))
  sockets.push(ws)
  const messages = []
  ws.addEventListener('message', e => messages.push(JSON.parse(e.data)))
  const wait = async predicate => {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const message = messages.find(predicate)
      if (message) return message
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error('消息等待超时')
  }
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }) })
  ws.send(JSON.stringify({ type: 'join', docId, clientId, lastRevision: 0, syncId: clientId }))
  await wait(m => m.type === 'sync' && m.syncId === clientId)
  return { ws, wait, clientId }
}
try {
  const owner = await api('/auth/login', 'POST', { username: 'testA', password: '123456' }, 200, null)
  token = owner.token
  const member = await api('/auth/login', 'POST', { username: 'testB', password: '123456' }, 200, null)
  memberId = member.user.id
  docId = (await api('/doc', 'POST', { title: 'History-' + randomUUID() })).id
  const base = `/doc/${docId}/history`
  await api(base, 'GET', undefined, 401, null)
  await api(base, 'GET', undefined, 403, member.token)
  await api(`/doc/${docId}/collaborators`, 'POST', { username: 'testB', permission: 1 })
  const a = await connect(origin, token, 'history-owner-' + randomUUID())
  const b = await connect(peerOrigin, member.token, 'history-reader-' + randomUUID())
  const rich = { ops: [{ insert: '重要正文', attributes: { bold: true } },
    { insert: { image: 'http://localhost:9000/collab/history-fixture.png' } }] }
  for (let revision = 1; revision <= 24; revision++) {
    a.ws.send(JSON.stringify({ type: 'op', docId, clientId: a.clientId, baseRevision: revision - 1,
      opId: 'edit-' + revision, op: revision === 1 ? rich : { ops: [{ insert: `更新${revision};` }] } }))
    await a.wait(m => m.type === 'ack' && m.revision === revision)
  }
  const historical = await api(base + '/1')
  assert.deepEqual(historical.content.ops, [...rich.ops, { insert: '\n' }])
  const page = await api(base + '?limit=10')
  assert.equal(page.list.length, 10)
  assert.equal(page.nextBeforeRevision, 15)
  const next = await api(base + '?limit=10&beforeRevision=' + page.nextBeforeRevision)
  assert.equal(next.list[0].revision, 14)
  await api(base + '/1/name', 'PUT', { name: '里程碑' })
  assert.equal((await api(base)).namedVersions[0].name, '里程碑')
  await api(base + '/1', 'GET', undefined, 200, member.token)
  await api(base + '/1/name', 'PUT', { name: '禁止' }, 403, member.token)
  await api(base + '/1/restore', 'POST', { expectedRevision: 24, requestId: randomUUID() }, 403, member.token)
  await api(base + '/1/restore', 'POST', { expectedRevision: 23, requestId: randomUUID() }, 409)
  await api(base + '/1/restore', 'POST', { requestId: randomUUID() }, 400)
  const body = { expectedRevision: 24, requestId: randomUUID() }
  assert.deepEqual(await api(base + '/1/restore', 'POST', body), { revision: 25, applied: true })
  await b.wait(m => m.type === 'op' && m.revision === 25 && m.originClientId === 'history-api')
  assert.deepEqual((await api(`/doc/${docId}`)).content, historical.content)
  assert.deepEqual(await api(base + '/1/restore', 'POST', body), { revision: 25, applied: false })
  await api(base + '/2/restore', 'POST', body, 409)
  assert.equal((await api(`/doc/${docId}`)).revision, 25)
  await api(base + '/0/restore', 'POST', { expectedRevision: 25, requestId: randomUUID() })
  assert.deepEqual((await api(`/doc/${docId}`)).content, { ops: [{ insert: '\n' }] })
  await api(base + '/1/name', 'DELETE')
  assert.equal((await api(base)).namedVersions.length, 0)
  await api(`/doc/${docId}/collaborators/${memberId}`, 'DELETE')
  await api(base + '/1', 'GET', undefined, 403, member.token)
  console.log(JSON.stringify({ docId, revision: 26, richTextAndEmbed: true, pagination: true,
    restoreBroadcast: true, ownerOnly: true, optimisticConflict: true, idempotent: true, initialVersion: true, revokedHistory: true }))
} finally {
  for (const ws of sockets) ws.close()
  if (docId && token) {
    await api(`/doc/${docId}/collaborators/${memberId}`, 'DELETE', undefined, 200).catch(() => {})
    await api(`/doc/${docId}`, 'DELETE')
  }
}
