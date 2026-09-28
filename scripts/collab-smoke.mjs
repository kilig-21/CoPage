import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const ports = [8080, 8081]
const username = process.env.COPAGE_SMOKE_USER ?? 'testA'
const password = process.env.COPAGE_SMOKE_PASSWORD ?? '123456'
const clients = []
let token
let docId

async function request(port, path, method = 'GET', body) {
  const response = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method,
    headers: {
      Authorization: token ? `Bearer ${token}` : '',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = await response.json()
  assert.equal(response.ok, true, `${method} ${path}: HTTP ${response.status}`)
  assert.equal(payload.code, 0, `${method} ${path}: ${payload.message}`)
  return payload.data
}

function openSocket(port) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/collab?token=${encodeURIComponent(token)}`)
    const messages = []
    const listeners = new Set()
    let opened = false
    socket.addEventListener('open', () => {
      opened = true
      const client = {
        socket,
        messages,
        send: (message) => socket.send(JSON.stringify(message)),
        waitFor(predicate, after = 0, timeoutMs = 20_000) {
          const existing = messages.slice(after).find(predicate)
          if (existing) return Promise.resolve(existing)
          return new Promise((resolveMessage, rejectMessage) => {
            const timer = setTimeout(() => {
              listeners.delete(listener)
              rejectMessage(new Error(`WebSocket ${port} 等待消息超时；最近消息：${JSON.stringify(messages.slice(-3))}`))
            }, timeoutMs)
            const listener = (message) => {
              if (!predicate(message)) return
              clearTimeout(timer)
              listeners.delete(listener)
              resolveMessage(message)
            }
            listeners.add(listener)
          })
        },
        close: () => socket.close(),
      }
      clients.push(client)
      resolve(client)
    })
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      messages.push(message)
      for (const listener of [...listeners]) listener(message)
    })
    socket.addEventListener('error', () => {
      if (!opened) reject(new Error(`WebSocket ${port} 连接失败`))
    })
  })
}

async function join(client, clientId, lastRevision, pending) {
  const syncId = randomUUID()
  const requestMessage = { type: 'join', docId, clientId, lastRevision, syncId }
  if (pending) {
    requestMessage.pendingOpId = pending.opId
    requestMessage.pendingBaseRevision = pending.baseRevision
    requestMessage.pendingOp = pending.op
  }
  const after = client.messages.length
  client.send(requestMessage)
  return client.waitFor(message => message.type === 'sync' && message.syncId === syncId, after)
}

async function submit(client, clientId, opId, baseRevision, op) {
  const payload = { type: 'op', docId, clientId, opId, baseRevision, op }
  let after = client.messages.length
  client.send(payload)
  for (let attempt = 0; attempt < 12; attempt++) {
    const message = await client.waitFor(item =>
      (item.type === 'ack' && item.opId === opId) || item.type === 'error', after, 30_000)
    if (message.type === 'ack') return message
    if (message.code !== 40901) throw new Error(`提交失败：${JSON.stringify(message)}`)
    after = client.messages.length
    await new Promise(resolve => setTimeout(resolve, 50 + attempt * 50))
    client.send(payload)
  }
  throw new Error(`操作 ${opId} 多次遇到文档忙`)
}

async function detail() {
  return request(8080, `/doc/${docId}`)
}

function text(content) {
  return content.ops.map(op => typeof op.insert === 'string' ? op.insert : '').join('')
}

async function run() {
  const login = await request(8080, '/auth/login', 'POST', { username, password })
  token = login.token
  const created = await request(8080, '/doc', 'POST', { title: `CODI-90 smoke ${randomUUID()}` })
  docId = created.id

  const aId = randomUUID()
  const bId = randomUUID()
  const a = await openSocket(8080)
  const b = await openSocket(8081)
  assert.equal((await join(a, aId, 0)).revision, 0)
  assert.equal((await join(b, bId, 0)).revision, 0)
  assert.equal((await submit(a, aId, randomUUID(), 0, { ops: [{ insert: 'A' }] })).revision, 1)
  assert.equal((await b.waitFor(message => message.type === 'op' && message.revision === 1)).revision, 1)
  assert.equal((await submit(b, bId, randomUUID(), 1,
    { ops: [{ retain: 1 }, { insert: 'B' }] })).revision, 2)
  assert.equal((await a.waitFor(message => message.type === 'op' && message.revision === 2)).revision, 2)
  assert.equal(text((await detail()).content), 'AB\n')

  const cId = randomUUID()
  const cOpId = randomUUID()
  const cOp = { ops: [{ retain: 2 }, { insert: 'C' }] }
  const c = await openSocket(8080)
  assert.equal((await join(c, cId, 2)).revision, 2)
  c.send({ type: 'op', docId, clientId: cId, opId: cOpId, baseRevision: 2, op: cOp })
  assert.equal((await c.waitFor(message => message.type === 'ack' && message.opId === cOpId)).revision, 3)
  c.close() // 模拟客户端没有处理已送达的 ack，保留原 pending 后重连另一实例。
  const cRecovered = await openSocket(8081)
  const cSync = await join(cRecovered, cId, 2, { opId: cOpId, baseRevision: 2, op: cOp })
  assert.equal(cSync.historyComplete, true)
  assert.equal(cSync.pendingCommittedRevision, 3)
  assert.deepEqual(cSync.history.map(item => item.revision), [3])
  assert.equal((await submit(cRecovered, cId, cOpId, 2, cOp)).revision, 3)
  assert.equal((await detail()).revision, 3)

  const dId = randomUUID()
  const dOpId = randomUUID()
  const dOp = { ops: [{ retain: 3 }, { insert: 'D' }] }
  const d = await openSocket(8080)
  await join(d, dId, 3)
  d.close() // 此操作尚未发送；服务端应返回 null 收据。
  const dRecovered = await openSocket(8081)
  const dSync = await join(dRecovered, dId, 3, { opId: dOpId, baseRevision: 3, op: dOp })
  assert.equal(dSync.pendingCommittedRevision, null)
  assert.equal(dSync.historyComplete, true)
  assert.equal((await submit(dRecovered, dId, dOpId, 3, dOp)).revision, 4)
  assert.equal(text((await detail()).content), 'ABCD\n')

  const stress = await Promise.all(Array.from({ length: 30 }, async (_, index) => {
    const clientId = randomUUID()
    const client = await openSocket(ports[index % 2])
    const sync = await join(client, clientId, 4)
    assert.equal(sync.revision, 4)
    return { client, clientId, opId: randomUUID(), char: String.fromCharCode(33 + index) }
  }))
  const acknowledgements = await Promise.all(stress.map(({ client, clientId, opId, char }) =>
    submit(client, clientId, opId, 4, { ops: [{ insert: char }] })))
  assert.deepEqual(acknowledgements.map(ack => ack.revision).sort((x, y) => x - y),
    Array.from({ length: 30 }, (_, index) => index + 5))
  const final = await detail()
  assert.equal(final.revision, 34)
  const finalText = text(final.content)
  assert.equal(finalText.length, 35)
  assert.ok(finalText.endsWith('ABCD\n'))
  for (const { char } of stress) assert.ok(finalText.includes(char))

  console.log(`PASS doc=${docId}: cross-instance op, committed/uncommitted reconnect, 30/30 ack, revision=${final.revision}`)
}

try {
  await run()
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  for (const client of clients) client.close()
  if (docId && token) {
    try {
      await request(8080, `/doc/${docId}`, 'DELETE')
      console.log(`Test document ${docId} soft-deleted`)
    } catch (error) {
      console.error(`Test document ${docId} cleanup failed:`, error)
      process.exitCode = 1
    }
  }
}
