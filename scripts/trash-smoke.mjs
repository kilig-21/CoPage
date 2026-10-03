import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const portA = Number(process.env.COPAGE_SMOKE_PORT_A ?? 8080)
const portB = Number(process.env.COPAGE_SMOKE_PORT_B ?? 8082)
const marker = 'Trash-' + randomUUID()
const sockets = []
let owner, member, docId
async function api(port, auth, path, method = 'GET', body, status = 200) {
  const response = await fetch(`http://localhost:${port}/api${path}`, {
    method, headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
  })
  const payload = await response.json()
  assert.equal(response.status, status, `${method} ${path}: ${payload.message}`)
  if (status === 200) assert.equal(payload.code, 0)
  return payload.data
}
async function connect(port, auth) {
  const socket = new WebSocket(`ws://localhost:${port}/ws/collab?token=${encodeURIComponent(auth)}`)
  sockets.push(socket)
  const clientId = 'trash-' + randomUUID(), messages = []
  let closeCode
  socket.addEventListener('message', event => messages.push(JSON.parse(event.data)))
  socket.addEventListener('close', event => { closeCode = event.code })
  const wait = async predicate => {
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      const found = messages.find(predicate)
      if (found) return found
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error('协同消息超时')
  }
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS 连接超时')), 10000)
    socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WS 连接失败')) }, { once: true })
  })
  socket.send(JSON.stringify({ type: 'join', docId, clientId, lastRevision: 0, syncId: clientId }))
  return { socket, clientId, messages, wait, get closeCode() { return closeCode } }
}
async function edit(client, revision, text) {
  const opId = randomUUID()
  client.socket.send(JSON.stringify({ type: 'op', docId, clientId: client.clientId, opId,
    baseRevision: revision, op: { ops: [{ insert: text }] } }))
  await client.wait(message => message.type === 'ack' && message.opId === opId && message.revision === revision + 1)
}
try {
  owner = await api(portA, null, '/auth/login', 'POST', { username: 'testA', password: '123456' })
  member = await api(portB, null, '/auth/login', 'POST', { username: 'testB', password: '123456' })
  await api(portA, null, '/doc/trash', 'GET', undefined, 401)
  await api(portA, owner.token, '/doc/trash?page=0', 'GET', undefined, 400)
  await api(portA, owner.token, '/doc/trash?size=101', 'GET', undefined, 400)
  docId = (await api(portA, owner.token, '/doc', 'POST', { title: marker, templateId: 'meeting' })).id
  await api(portA, owner.token, `/doc/${docId}/collaborators`, 'POST', { username: 'testB', permission: 2 })
  const a = await connect(portA, owner.token), b = await connect(portB, member.token)
  await a.wait(m => m.type === 'sync'); await b.wait(m => m.type === 'sync')
  await edit(b, 0, '删除前正文：')
  await a.wait(m => m.type === 'op' && m.revision === 1)
  await api(portA, owner.token, `/doc/${docId}/history/1/name`, 'PUT', { name: '删除前重要版本' })
  const before = await api(portA, owner.token, `/doc/${docId}`)
  await api(portA, owner.token, `/doc/${docId}`, 'DELETE')
  for (const client of [a, b]) {
    await client.wait(m => m.type === 'permission' && m.permission === 0)
    const deadline = Date.now() + 2000
    while (client.closeCode === undefined && Date.now() < deadline) await new Promise(r => setTimeout(r, 20))
    assert.equal(client.closeCode, 1008, '删除后两端及时关闭，不等待心跳')
  }
  for (const auth of [owner.token, member.token]) {
    await api(portB, auth, `/doc/${docId}`, 'GET', undefined, 404)
    await api(portB, auth, `/doc/${docId}/history`, 'GET', undefined, 404)
    assert.equal((await api(portB, auth, '/search?q=' + encodeURIComponent(marker))).total, 0)
    assert.ok(!(await api(portB, auth, '/doc/list?size=100')).list.some(row => row.id === docId))
  }
  const trash = await api(portA, owner.token, '/doc/trash?size=100')
  const row = trash.list.find(row => row.id === docId)
  assert.ok(row); assert.deepEqual(Object.keys(row).sort(), ['deletedAt', 'id', 'title'])
  assert.ok(!(await api(portB, member.token, '/doc/trash?size=100')).list.some(row => row.id === docId))
  await api(portB, member.token, `/doc/${docId}/restore`, 'POST', undefined, 404)
  await api(portA, null, `/doc/${docId}/restore`, 'POST', undefined, 401)
  const denied = await connect(portB, member.token)
  await denied.wait(m => m.type === 'error' && m.code === 404)
  denied.socket.close()
  await Promise.all([1, 2].map(() => api(portA, owner.token, `/doc/${docId}/restore`, 'POST')))
  const restored = await api(portB, member.token, `/doc/${docId}`)
  assert.equal(restored.revision, before.revision); assert.deepEqual(restored.content, before.content)
  assert.equal(restored.permission, 2)
  assert.deepEqual((await api(portA, owner.token, `/doc/${docId}/history/1`)).content, before.content)
  assert.ok((await api(portA, owner.token, `/doc/${docId}/history`)).list.some(row => row.revision === 1 && row.name === '删除前重要版本'))
  assert.equal((await api(portB, member.token, '/search?q=' + encodeURIComponent(marker))).total, 1)
  const active = await connect(portB, member.token)
  await active.wait(m => m.type === 'sync')
  await edit(active, 1, '恢复后继续：')
  await api(portA, owner.token, `/doc/${docId}/restore`, 'POST')
  const edited = await api(portA, owner.token, `/doc/${docId}`)
  assert.equal(edited.revision, 2); assert.ok(JSON.stringify(edited.content).includes('恢复后继续：'))
  console.log(JSON.stringify({ docId, ports: [portA, portB], ownerOnly: true, noBodyInTrash: true,
    deletionClosesBothSockets: true, hiddenFromSearch: true, contentHistoryAndPermissionsPreserved: true,
    concurrentRestoreIdempotent: true, restoredMemberCanEdit: true, revision: 2 }))
} finally {
  for (const socket of sockets) socket.close()
  if (docId && owner) {
    // 只清理本脚本创建的文档、成员与版本标记，不触及既有回收站内容。
    await api(portA, owner.token, `/doc/${docId}/restore`, 'POST')
    await api(portA, owner.token, `/doc/${docId}/history/1/name`, 'DELETE')
    await api(portA, owner.token, `/doc/${docId}/collaborators/${member.user.id}`, 'DELETE')
    await api(portA, owner.token, `/doc/${docId}`, 'DELETE')
    console.log(`Test document ${docId} soft-deleted`)
  }
}
