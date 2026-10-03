import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const portA = Number(process.env.COPAGE_SMOKE_PORT_A ?? 8080)
const portB = Number(process.env.COPAGE_SMOKE_PORT_B ?? 8082)
const marker = 'Daily-' + randomUUID()
const sockets = []
let owner, member, docId, memberAdded = false
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
  const clientId = 'daily-' + randomUUID(), messages = []
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
try {
  owner = await api(portA, null, '/auth/login', 'POST', { username: 'testA', password: '123456' })
  member = await api(portB, null, '/auth/login', 'POST', { username: 'testB', password: '123456' })
  docId = (await api(portA, owner.token, '/doc', 'POST', { title: marker })).id
  await api(portA, null, `/doc/${docId}/metadata`, 'GET', undefined, 401)
  await api(portB, member.token, `/doc/${docId}/metadata`, 'GET', undefined, 403)
  await api(portA, owner.token, `/doc/${docId}/collaborators`, 'POST', { username: 'testB', permission: 1 })
  memberAdded = true
  const a = await connect(portA, owner.token), b = await connect(portB, member.token)
  await a.wait(m => m.type === 'sync'); await b.wait(m => m.type === 'sync')
  await api(portB, member.token, `/doc/${docId}`, 'PUT', { title: '禁止只读改名' }, 403)
  const title = marker + ' %_! 中文标题'
  await api(portA, owner.token, `/doc/${docId}`, 'PUT', { title })
  for (const client of [a, b]) {
    const event = await client.wait(m => m.type === 'metadata')
    assert.deepEqual(event, { type: 'metadata', docId })
  }
  const metadata = await api(portB, member.token, `/doc/${docId}/metadata`)
  assert.deepEqual(Object.keys(metadata).sort(), ['id', 'title', 'updateTime'])
  assert.equal(metadata.title, title)
  assert.equal((await api(portB, member.token, `/doc/${docId}`)).revision, 0)
  for (const keyword of ['%_!', '中文标题']) {
    const result = await api(portB, member.token, '/doc/list?keyword=' + encodeURIComponent(keyword))
    assert.ok(result.list.some(row => row.id === docId))
    assert.ok(result.list.every(row => row.title.includes(keyword)))
  }
  await api(portA, owner.token, `/doc/${docId}/collaborators/${member.user.id}`, 'PUT', { permission: 2 })
  await api(portB, member.token, `/doc/${docId}`, 'PUT', { title: marker + ' 第二次' })
  assert.equal((await api(portA, owner.token, `/doc/${docId}/metadata`)).title, marker + ' 第二次')
  await api(portA, owner.token, `/doc/${docId}/collaborators/${member.user.id}`, 'DELETE')
  memberAdded = false
  await b.wait(m => m.type === 'permission' && m.permission === 0)
  await api(portB, member.token, `/doc/${docId}/metadata`, 'GET', undefined, 403)
  await api(portA, owner.token, `/doc/${docId}`, 'DELETE')
  await api(portA, owner.token, `/doc/${docId}/metadata`, 'GET', undefined, 404)
  console.log(JSON.stringify({ docId, ports: [portA, portB], metadataCrossInstance: true,
    readonlyCannotRename: true, metadataChecksCurrentPermission: true, literalTitleFilter: true, bodyRevisionUnchanged: true }))
} finally {
  for (const socket of sockets) socket.close()
  if (docId && owner) {
    await api(portA, owner.token, `/doc/${docId}/restore`, 'POST')
    if (memberAdded) await api(portA, owner.token, `/doc/${docId}/collaborators/${member.user.id}`, 'DELETE')
    await api(portA, owner.token, `/doc/${docId}`, 'DELETE')
    console.log(`Test document ${docId} soft-deleted`)
  }
}
