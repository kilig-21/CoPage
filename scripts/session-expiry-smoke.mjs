import assert from 'node:assert/strict'
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'

const ports = [Number(process.env.COPAGE_SMOKE_PORT_A ?? 8080), Number(process.env.COPAGE_SMOKE_PORT_B ?? 8082)]
for (const port of ports) assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, '无效烟测端口')
const secret = process.env.COPAGE_SMOKE_JWT_SECRET
assert.ok(secret && Buffer.byteLength(secret) >= 32, '仅用明确提供的测试签名密钥；不从用户密钥文件读取')
const owner = { username: 'expiry' + randomBytes(6).toString('hex'), password: randomBytes(24).toString('hex'), nickname: '有效期验收账号' }
const title = 'SessionExpiry-' + randomUUID()
const origin = port => `http://127.0.0.1:${port}`
const sockets = []
let ownerId, docId, ownerToken, memberId, memberToken, revision = 0, content = '\n'

async function api(port, token, path, method = 'GET', body, status = 200) {
  const response = await fetch(origin(port) + '/api' + path, {
    method, signal: AbortSignal.timeout(15000),
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await response.json()
  assert.equal(response.status, status, `${method} ${path}: ${json.message}`)
  if (status === 200) assert.equal(json.code, 0)
  return json.data
}
function shortToken(token, seconds) {
  const [header, payload, signature] = token.split('.')
  const algorithm = { HS256: 'sha256', HS384: 'sha384', HS512: 'sha512' }[JSON.parse(Buffer.from(header, 'base64url')).alg]
  assert.ok(algorithm, '只支持本项目HMAC测试令牌')
  const expected = createHmac(algorithm, secret).update(header + '.' + payload).digest()
  const received = Buffer.from(signature, 'base64url')
  assert.ok(expected.length === received.length && timingSafeEqual(expected, received), '测试密钥与实际登录签名不一致')
  const claims = JSON.parse(Buffer.from(payload, 'base64url'))
  const expires = Math.floor(Date.now() / 1000) + seconds
  const next = Buffer.from(JSON.stringify({ ...claims, exp: expires })).toString('base64url')
  return { token: header + '.' + next + '.' + createHmac(algorithm, secret).update(header + '.' + next).digest('base64url'), expires }
}
async function connect(port, token, clientId, lastRevision = 0) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/collab?token=${encodeURIComponent(token)}`)
  sockets.push(ws)
  const messages = []
  let closed = false
  ws.addEventListener('message', event => messages.push(JSON.parse(event.data)))
  ws.addEventListener('close', () => { closed = true })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('有效期WS连接超时')), 15000)
    ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('有效期WS连接拒绝')) }, { once: true })
  })
  const wait = async (predicate, after = 0) => {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const found = messages.slice(after).find(predicate)
      if (found) return found
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error('有效期WS消息超时')
  }
  ws.send(JSON.stringify({ type: 'join', docId, clientId, lastRevision, syncId: clientId }))
  await wait(message => message.type === 'sync' && message.syncId === clientId)
  return { ws, messages, wait, get closed() { return closed }, async submit(baseRevision, text) {
    const after = messages.length, opId = randomUUID()
    ws.send(JSON.stringify({ type: 'op', docId, clientId, opId, baseRevision, op: { ops: [{ insert: text }] } }))
    return await wait(message => (message.type === 'ack' && message.opId === opId) || message.type === 'error', after)
  } }
}
async function handshakeDenied(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/collab?token=${encodeURIComponent(token)}`)
  sockets.push(ws)
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('过期握手没有结束')), 15000)
    ws.addEventListener('error', () => { clearTimeout(timer); resolve(true) }, { once: true })
    ws.addEventListener('open', () => { clearTimeout(timer); ws.close(); resolve(false) }, { once: true })
  })
}
async function cleanup(expectedRevision, expectedContent) {
  if (!docId) return
  const document = await api(ports[0], ownerToken, '/doc/' + docId)
  assert.equal(document.ownerId, ownerId); assert.equal(document.title, title)
  assert.equal(document.revision, expectedRevision); assert.deepEqual(document.content, { ops: [{ insert: expectedContent }] })
  assert.equal((await api(ports[0], ownerToken, `/doc/${docId}/history`)).namedVersions.length, 0)
  const members = await api(ports[0], ownerToken, `/doc/${docId}/collaborators`)
  assert.ok(members.every(member => member.userId === memberId))
  for (const member of members) await api(ports[0], ownerToken, `/doc/${docId}/collaborators/${member.userId}`, 'DELETE')
  await api(ports[0], ownerToken, '/doc/' + docId, 'DELETE')
  console.log(JSON.stringify({ cleanedDocId: docId, revision: expectedRevision, syntheticAccountsPreserved: true }))
}
ownerId = (await api(ports[0], null, '/auth/register', 'POST', owner)).id
ownerToken = (await api(ports[0], null, '/auth/login', 'POST', owner)).token
// 签名来源必须与实际服务一致；不构造其他账号或无权文档的令牌。
shortToken(ownerToken, 20)

if (process.argv.includes('--browser-fixture')) {
  const nonce = randomBytes(24).toString('hex')
  const draftText = '真实过期未确认草稿😀\n'
  const server = createServer(async (request, response) => {
    try {
      if (request.socket.remoteAddress !== '127.0.0.1') { response.writeHead(403); response.end(); return }
      if (request.method === 'GET' && request.url === '/' + nonce) {
        const issued = shortToken(ownerToken, 20)
        response.setHeader('Content-Type', 'application/json'); response.setHeader('Cache-Control', 'no-store')
        response.end(JSON.stringify({ username: owner.username, password: owner.password, ownerId, title, shortToken: issued.token, expires: issued.expires }))
      } else if (request.method === 'POST' && request.url === '/' + nonce + '/finish') {
        let body = ''
        for await (const chunk of request) { body += chunk; assert.ok(body.length < 1024) }
        docId = JSON.parse(body).docId
        assert.ok(Number.isSafeInteger(docId) && docId > 0)
        await cleanup(1, draftText)
        response.once('finish', () => { server.close(); server.closeIdleConnections() })
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ cleaned: true, docId }))
      } else { response.writeHead(404); response.end() }
    } catch { response.writeHead(500); response.end('fixture verification failed'); process.exitCode = 1 }
  })
  server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ fixtureUrl: `http://127.0.0.1:${server.address().port}/${nonce}` })))
} else {
  try {
    const member = { username: 'expirypeer' + randomBytes(6).toString('hex'), password: randomBytes(24).toString('hex') }
    memberId = (await api(ports[1], null, '/auth/register', 'POST', member)).id
    memberToken = (await api(ports[1], null, '/auth/login', 'POST', member)).token
    docId = (await api(ports[0], ownerToken, '/doc', 'POST', { title })).id
    await api(ports[0], ownerToken, `/doc/${docId}/collaborators`, 'POST', { username: member.username, permission: 2 })
    const short = shortToken(ownerToken, 8)
    const a = await connect(ports[0], short.token, 'expiry-a-' + randomUUID())
    const b = await connect(ports[1], short.token, 'expiry-b-' + randomUUID())
    const peer = await connect(ports[1], memberToken, 'expiry-peer-' + randomUUID())
    assert.equal((await a.submit(0, '有效期前|')).revision, 1)
    revision = 1; content = '有效期前|\n'
    await b.wait(message => message.type === 'op' && message.revision === 1)
    while (Date.now() <= short.expires * 1000 + 50) await new Promise(resolve => setTimeout(resolve, 20))
    const rejected = await a.submit(1, '不应保存的过期输入|')
    if (rejected.type === 'ack') { revision = 2; content = '不应保存的过期输入|' + content }
    assert.equal(rejected.type, 'error', '过期会话仍可提交正文')
    assert.equal(rejected.code, 401)
    for (const port of ports) {
      await api(port, short.token, '/account/me', 'GET', undefined, 401)
      await api(port, short.token, '/doc/' + docId, 'GET', undefined, 401)
      assert.ok(await handshakeDenied(port, short.token))
    }
    assert.equal((await peer.submit(1, '成员继续|')).revision, 2)
    revision = 2; content = '成员继续|' + content
    await b.wait(message => message.type === 'error' && message.code === 401)
    assert.equal(b.messages.some(message => message.type === 'op' && message.revision === 2), false)
    const deadline = Date.now() + 5000
    while ((!a.closed || !b.closed) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(a.closed && b.closed)
    assert.equal(peer.closed, false)
    assert.equal((await api(ports[0], ownerToken, '/doc/' + docId)).revision, 2)
    const fresh = await connect(ports[0], ownerToken, 'expiry-renewed-' + randomUUID(), 2)
    assert.equal((await fresh.submit(2, '重新登录继续|')).revision, 3)
    revision = 3; content = '重新登录继续|' + content
    assert.deepEqual((await api(ports[1], ownerToken, '/doc/' + docId)).content, { ops: [{ insert: content }] })
    console.log(JSON.stringify({ docId, ownerId, memberId, ports, expiredWriteRejected: true, expiredBroadcastBlocked: true,
      expiredHttpAndHandshakesRejected: true, memberUnaffected: true, newValidSessionContinues: true, revision }))
  } finally {
    for (const socket of sockets) socket.close()
    try { await cleanup(revision, content) } catch { console.error('本轮合成文档清理未完成，保留待复核'); process.exitCode = 1 }
  }
}
