import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const portA = Number(process.env.COPAGE_SMOKE_PORT_A ?? 8080)
const portB = Number(process.env.COPAGE_SMOKE_PORT_B ?? 8081)
const sockets = []
let owner, member, docId
const marker = 'Members-' + randomUUID()

async function api(port, token, path, method = 'GET', body, status = 200) {
  const response = await fetch(`http://localhost:${port}/api${path}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = await response.json()
  assert.equal(response.status, status, `${method} ${path}: ${payload.message}`)
  if (status === 200) assert.equal(payload.code, 0)
  return payload.data
}

async function connect(port, token, clientId) {
  const socket = new WebSocket(`ws://localhost:${port}/ws/collab?token=${encodeURIComponent(token)}`)
  sockets.push(socket)
  const messages = []
  socket.addEventListener('message', (event) => messages.push(JSON.parse(event.data)))
  const wait = async (predicate) => {
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      const result = messages.find(predicate)
      if (result) return result
      await new Promise(resolve => setTimeout(resolve, 30))
    }
    throw new Error('协同消息超时')
  }
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', () => reject(new Error('WS 连接失败')), { once: true }) })
  socket.send(JSON.stringify({ type: 'join', docId, clientId, lastRevision: 0, syncId: clientId }))
  await wait(message => message.type === 'sync' && message.syncId === clientId)
  return { socket, messages, wait, clientId }
}

try {
  owner = await api(portA, null, '/auth/login', 'POST', { username: 'testA', password: '123456' })
  member = await api(portB, null, '/auth/login', 'POST', { username: 'testB', password: '123456' })
  docId = (await api(portA, owner.token, '/doc', 'POST', { title: marker })).id
  const base = `/doc/${docId}/collaborators`
  await api(portB, member.token, `/doc/${docId}`, 'GET', undefined, 403)
  await api(portA, null, base, 'GET', undefined, 401)
  assert.equal((await api(portB, member.token, '/search?q=' + marker)).total, 0)
  await api(portA, owner.token, base, 'POST', { username: 'testA', permission: 2 }, 400)
  await api(portA, owner.token, base, 'POST', { username: 'unknown-' + randomUUID(), permission: 1 }, 404)
  await api(portA, owner.token, base, 'POST', { username: ' testB ', permission: 2 })
  await api(portA, owner.token, base, 'POST', { username: 'testB', permission: 1 }, 400)
  assert.equal((await api(portA, owner.token, base))[0].permission, 2)
  for (const [method, path, body] of [
    ['GET', base], ['POST', base, { username: 'testA', permission: 2 }],
    ['PUT', base + '/' + member.user.id, { permission: 1 }], ['DELETE', base + '/' + member.user.id],
  ]) await api(portB, member.token, path, method, body, 403)

  const b = await connect(portB, member.token, 'member-' + randomUUID())
  const a = await connect(portA, owner.token, 'owner-' + randomUUID())
  await api(portA, owner.token, base + '/' + member.user.id, 'PUT', { permission: 1 })
  await b.wait(message => message.type === 'permission' && message.permission === 1)
  b.socket.send(JSON.stringify({ type: 'op', docId, clientId: b.clientId, opId: 'readonly', baseRevision: 0, op: { ops: [{ insert: 'denied' }] } }))
  await b.wait(message => message.type === 'error' && message.code === 403)
  assert.equal((await api(portA, owner.token, `/doc/${docId}`)).revision, 0)
  b.messages.length = 0
  await api(portA, owner.token, base + '/' + member.user.id, 'PUT', { permission: 2 })
  await b.wait(message => message.type === 'permission' && message.permission === 2)
  b.socket.send(JSON.stringify({ type: 'op', docId, clientId: b.clientId, opId: 'edit', baseRevision: 0, op: { ops: [{ insert: marker }] } }))
  await b.wait(message => message.type === 'ack' && message.revision === 1)
  await a.wait(message => message.type === 'op' && message.revision === 1)
  assert.equal((await api(portB, member.token, '/search?q=' + marker)).total, 1)
  await api(portA, owner.token, base + '/' + member.user.id, 'DELETE')
  await b.wait(message => message.type === 'permission' && message.permission === 0)
  await api(portB, member.token, `/doc/${docId}`, 'GET', undefined, 403)
  assert.equal((await api(portB, member.token, '/search?q=' + marker)).total, 0)
  assert.ok(!(await api(portB, member.token, '/doc/list?size=100')).list.some(doc => doc.id === docId))
  a.socket.send(JSON.stringify({ type: 'op', docId, clientId: a.clientId, opId: 'after-revoke', baseRevision: 1, op: { ops: [{ insert: 'after-revoke' }] } }))
  await a.wait(message => message.type === 'ack' && message.revision === 2)
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.ok(!b.messages.some(message => message.type === 'op' && message.revision === 2))
  assert.equal(b.socket.readyState, WebSocket.CLOSED)
  console.log(JSON.stringify({ docId, ports: [portA, portB], ownerOnly: true, duplicatePreserved: true,
    liveDowngrade: true, liveUpgrade: true, revokedSocketClosed: true, revokedSearchHidden: true, revision: 2 }))
} finally {
  for (const socket of sockets) socket.close()
  if (docId && owner) {
    const members = await api(portA, owner.token, `/doc/${docId}/collaborators`)
    for (const collaborator of members) await api(portA, owner.token, `/doc/${docId}/collaborators/${collaborator.userId}`, 'DELETE')
    await api(portA, owner.token, `/doc/${docId}`, 'DELETE')
  }
}
