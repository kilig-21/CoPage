import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'

const ports = [Number(process.env.COPAGE_SMOKE_PORT_A ?? 8080), Number(process.env.COPAGE_SMOKE_PORT_B ?? 8082)]
for (const port of ports) assert.ok(Number.isInteger(port) && port >= 1 && port <= 65535, '无效烟测端口')
const owner = { username: 'account' + randomBytes(6).toString('hex'), password: randomBytes(24).toString('hex'), nickname: '合成账号原昵称' }
const member = { username: 'member' + randomBytes(6).toString('hex'), password: randomBytes(24).toString('hex'), nickname: '合成协作者' }
const newPassword = randomBytes(24).toString('hex')
const marker = 'AccountSmoke-' + randomUUID()
const sockets = []
let ownerId, memberId, docId, currentToken, memberToken, passwordChanged = false

async function api(port, token, path, method = 'GET', body, status = 200) {
  const r = await fetch(`http://localhost:${port}/api${path}`, {
    method, signal: AbortSignal.timeout(15000), headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    }, body: body === undefined ? undefined : JSON.stringify(body),
  })
  const j = await r.json()
  assert.equal(r.status, status, `${method} ${path}: ${j.message}`)
  if (status === 200) assert.equal(j.code, 0)
  return j.data
}
const credentialVersion = token => JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).credentialVersion
async function connect(port, token, clientId, revision = 0) {
  const ws = new WebSocket(`ws://localhost:${port}/ws/collab?token=${encodeURIComponent(token)}`)
  sockets.push(ws)
  const messages = []
  let closed = false
  ws.addEventListener('message', e => messages.push(JSON.parse(e.data)))
  ws.addEventListener('close', () => { closed = true })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS连接超时')), 15000)
    ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WS连接被拒绝')) }, { once: true })
  })
  const wait = async predicate => {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) { const found = messages.find(predicate); if (found) return found; await new Promise(r => setTimeout(r, 20)) }
    throw new Error('WS消息超时')
  }
  ws.send(JSON.stringify({ type: 'join', docId, clientId, lastRevision: revision, syncId: clientId }))
  const sync = await wait(m => m.type === 'sync' && m.syncId === clientId)
  return { ws, wait, sync, get closed() { return closed }, async submit(baseRevision, text) {
    const opId = randomUUID()
    ws.send(JSON.stringify({ type: 'op', docId, clientId, opId, baseRevision, op: { ops: [{ insert: text }] } }))
    return await wait(m => m.type === 'ack' && m.opId === opId)
  } }
}
async function rejectedHandshake(port, token) {
  const ws = new WebSocket(`ws://localhost:${port}/ws/collab?token=${encodeURIComponent(token)}`)
  sockets.push(ws)
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('旧WS握手未得到拒绝')), 15000)
    ws.addEventListener('open', () => { clearTimeout(timer); ws.close(); resolve(false) }, { once: true })
    ws.addEventListener('error', () => { clearTimeout(timer); resolve(true) }, { once: true })
  })
}
try {
  await api(ports[0], null, '/account/me', 'GET', undefined, 401)
  ownerId = (await api(ports[0], null, '/auth/register', 'POST', owner)).id
  memberId = (await api(ports[1], null, '/auth/register', 'POST', member)).id
  const original = await api(ports[0], null, '/auth/login', 'POST', owner)
  currentToken = original.token
  const oldToken = currentToken
  memberToken = (await api(ports[1], null, '/auth/login', 'POST', member)).token
  assert.equal(credentialVersion(oldToken), 0)
  const profile = await api(ports[1], oldToken, '/account/me')
  assert.deepEqual(Object.keys(profile).sort(), ['avatar', 'id', 'nickname', 'username'])
  assert.equal(profile.id, ownerId)
  await api(ports[0], oldToken, '/account/me', 'PUT', { nickname: '   ' }, 400)
  await api(ports[0], oldToken, '/account/me', 'PUT', { nickname: 'a'.repeat(51) }, 400)
  await api(ports[0], oldToken, '/account/me', 'PUT', { nickname: ' 改名账号😀 ', userId: memberId, username: 'cannot-rename-login' })
  assert.equal((await api(ports[1], oldToken, '/account/me')).nickname, '改名账号😀')
  assert.equal((await api(ports[1], oldToken, '/account/me')).username, owner.username)
  assert.equal((await api(ports[0], memberToken, '/account/me')).nickname, member.nickname)
  await api(ports[0], oldToken, '/account/password', 'POST', { currentPassword: 'wrong-password', newPassword }, 400)
  await api(ports[0], oldToken, '/account/password', 'POST', { currentPassword: owner.password, newPassword: '中'.repeat(25) }, 400)
  await api(ports[0], oldToken, '/account/password', 'POST', { currentPassword: owner.password, newPassword: owner.password }, 400)
  await api(ports[1], oldToken, '/account/me')
  docId = (await api(ports[0], oldToken, '/doc', 'POST', { title: marker })).id
  await api(ports[0], oldToken, `/doc/${docId}/collaborators`, 'POST', { username: member.username, permission: 2 })
  const a = await connect(ports[0], oldToken, 'owner-a-' + randomUUID())
  const b = await connect(ports[1], oldToken, 'owner-b-' + randomUUID())
  const m = await connect(ports[1], memberToken, 'member-' + randomUUID())
  assert.ok(a.sync.users.some(u => u.userId === ownerId && u.nickname === '改名账号😀'))
  assert.equal((await a.submit(0, '改密前正文|')).revision, 1)
  await b.wait(value => value.type === 'op' && value.revision === 1)
  await api(ports[0], oldToken, '/account/password', 'POST', { currentPassword: owner.password, newPassword })
  passwordChanged = true
  await a.wait(value => value.type === 'error' && value.code === 401)
  await b.wait(value => value.type === 'error' && value.code === 401)
  const closedDeadline = Date.now() + 5000
  while ((!a.closed || !b.closed) && Date.now() < closedDeadline) await new Promise(r => setTimeout(r, 20))
  assert.ok(a.closed && b.closed, '两个实例的旧所有者连接必须关闭')
  for (const port of ports) {
    await api(port, oldToken, '/account/me', 'GET', undefined, 401)
    await api(port, oldToken, `/doc/${docId}`, 'GET', undefined, 401)
    assert.ok(await rejectedHandshake(port, oldToken))
  }
  await api(ports[1], null, '/auth/login', 'POST', owner, 401)
  const fresh = await api(ports[1], null, '/auth/login', 'POST', { username: owner.username, password: newPassword })
  currentToken = fresh.token
  assert.equal(credentialVersion(currentToken), 1)
  const saved = await api(ports[0], currentToken, `/doc/${docId}`)
  assert.equal(saved.revision, 1)
  assert.deepEqual(saved.content, { ops: [{ insert: '改密前正文|\n' }] })
  assert.equal((await api(ports[0], currentToken, `/doc/${docId}/collaborators`))[0].permission, 2)
  assert.equal(m.closed, false)
  assert.equal((await m.submit(1, '成员继续|')).revision, 2)
  const renewed = await connect(ports[0], currentToken, 'new-owner-' + randomUUID(), 2)
  assert.equal((await renewed.submit(2, '新登录继续|')).revision, 3)
  await m.wait(value => value.type === 'op' && value.revision === 3)
  console.log(JSON.stringify({ docId, ownerId, memberId, ports, publicProfileOnly: true, ownNicknameOnly: true,
    originalPasswordRequired: true, oldHttpAndHandshakesDenied: true, bothOldOwnerSocketsClosed: true,
    memberUnaffected: true, oldLoginDenied: true, newLoginVersion: 1, documentAndPermissionsPreserved: true, revision: 3 }))
} finally {
  for (const socket of sockets) socket.close()
  if (docId) {
    try {
      // 请求结果不明确时只尝试本轮生成的新/旧密码，不重置账号或直接改库。
      const candidates = passwordChanged ? [newPassword, owner.password] : [owner.password, newPassword]
      let cleanupToken
      for (const password of candidates) {
        try { cleanupToken = (await api(ports[0], null, '/auth/login', 'POST', { username: owner.username, password })).token; break } catch { }
      }
      assert.ok(cleanupToken, '本轮测试账号清理登录失败')
      const d = await api(ports[0], cleanupToken, `/doc/${docId}`)
      assert.equal(d.ownerId, ownerId); assert.equal(d.title, marker)
      assert.ok(d.revision >= 0 && d.revision <= 3, '出现本轮预期之外的编辑，保留文档')
      assert.equal((await api(ports[0], cleanupToken, `/doc/${docId}/history`)).namedVersions.length, 0)
      const members = await api(ports[0], cleanupToken, `/doc/${docId}/collaborators`)
      assert.ok(members.every(member => member.userId === memberId))
      for (const member of members) await api(ports[0], cleanupToken, `/doc/${docId}/collaborators/${member.userId}`, 'DELETE')
      await api(ports[0], cleanupToken, `/doc/${docId}`, 'DELETE')
      console.log(`本轮账号烟测文档${docId}已软删除，合成账号保留`)
    } catch { console.error(`本轮合成文档${docId}清理未完成；保留数据供复核`); process.exitCode = 1 }
  }
}
