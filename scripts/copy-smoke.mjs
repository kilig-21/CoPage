import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const origin = process.env.COPAGE_COPY_ORIGIN || 'http://localhost:8080'
const peer = process.env.COPAGE_COPY_PEER_ORIGIN || 'http://localhost:8082'
const records = [], sockets = new Set()
const marker = 'Copy-' + randomUUID()
let owner, member

async function api(base, token, path, method = 'GET', body, status = 200) {
  const response = await fetch(base + '/api' + path, {
    method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000),
  })
  const result = await response.json()
  assert.equal(response.status, status, method + ' ' + path + ': ' + result.message)
  if (status === 200) assert.equal(result.code, 0)
  return result.data
}

function insert(base, token, docId, baseRevision, op) {
  return new Promise((resolve, reject) => {
    const clientId = randomUUID(), syncId = randomUUID(), opId = randomUUID()
    const socket = new WebSocket(base.replace(/^http/, 'ws') + '/ws/collab?token=' + encodeURIComponent(token))
    sockets.add(socket)
    let done = false
    const finish = (error, revision) => {
      if (done) return
      done = true; clearTimeout(timer); socket.close(); sockets.delete(socket)
      if (error) reject(error); else resolve(revision)
    }
    const timer = setTimeout(() => finish(new Error('副本烟测协作消息超时')), 20_000)
    socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'join', docId, clientId, syncId, lastRevision: baseRevision })))
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data)
      if (message.type === 'error') { finish(new Error('协作拒绝：' + message.code)); return }
      if (message.type === 'sync' && message.syncId === syncId) socket.send(JSON.stringify({ type: 'op', docId, clientId, opId, baseRevision, op }))
      if (message.type === 'ack' && message.opId === opId) finish(null, message.revision)
    })
    socket.addEventListener('error', () => finish(new Error('协作连接失败')))
    socket.addEventListener('close', () => { if (!done) finish(new Error('协作确认前断开')) })
  })
}

function keep(copy, auth, title) {
  assert.ok(Number.isSafeInteger(copy.id) && copy.id > 26)
  records.push({ id: copy.id, token: auth.token, ownerId: auth.user.id, title, deleted: false })
  return copy
}

try {
  owner = await api(origin, null, '/auth/login', 'POST', { username: 'testA', password: '123456' })
  member = await api(peer, null, '/auth/login', 'POST', { username: 'testB', password: '123456' })
  const source = keep(await api(origin, owner.token, '/doc', 'POST', { title: marker }), owner, marker)
  await api(origin, null, '/doc/' + source.id + '/copy', 'POST', {}, 401)
  await api(origin, member.token, '/doc/' + source.id + '/copy', 'POST', {}, 403)
  await api(origin, owner.token, '/doc/0/copy', 'POST', {}, 400)
  for (const title of [' ', '标题'.repeat(101)]) await api(origin, owner.token, '/doc/' + source.id + '/copy', 'POST', { title }, 400)

  assert.equal(await insert(origin, owner.token, source.id, 0, { ops: [{ insert: '大'.repeat(400000) }] }), 1)
  const saved = await api(origin, owner.token, '/doc/' + source.id)
  assert.ok(Buffer.byteLength(JSON.stringify(saved.content), 'utf8') > 1024 * 1024)
  await api(origin, owner.token, '/doc/' + source.id + '/export?format=copage', 'GET', undefined, 400)
  await api(origin, owner.token, '/doc/' + source.id + '/collaborators', 'POST', { username: 'testB', permission: 1 })
  const title = marker + '-reader'
  const copied = keep(await api(peer, member.token, '/doc/' + source.id + '/copy', 'POST', { title }), member, title)
  assert.equal(copied.sourceRevision, 1)
  const detail = await api(origin, member.token, '/doc/' + copied.id)
  assert.equal(detail.ownerId, member.user.id)
  assert.equal(detail.revision, 0)
  assert.deepEqual(detail.content, saved.content)
  assert.deepEqual((await api(peer, member.token, '/doc/' + copied.id + '/history/0')).content, saved.content)
  assert.equal((await api(origin, member.token, '/doc/' + copied.id + '/collaborators')).length, 0)
  await api(origin, owner.token, '/doc/' + copied.id, 'GET', undefined, 403)
  await api(origin, owner.token, '/doc/' + copied.id + '/copy', 'POST', {}, 403)

  const ownTitle = marker + ' 的副本'
  const own = keep(await api(origin, owner.token, '/doc/' + source.id + '/copy', 'POST', {}), owner, ownTitle)
  assert.equal(own.title, ownTitle)
  assert.equal(own.sourceRevision, 1)
  assert.deepEqual((await api(peer, owner.token, '/doc/' + own.id)).content, saved.content)
  await api(origin, member.token, '/doc/' + own.id, 'GET', undefined, 403)
  assert.equal(await insert(peer, member.token, copied.id, 0, { ops: [{ insert: '副本独立|' }] }), 1)
  assert.deepEqual((await api(origin, owner.token, '/doc/' + source.id)).content, saved.content)
  assert.deepEqual((await api(origin, owner.token, '/doc/' + own.id)).content, saved.content)
  const search = await api(origin, member.token, '/search?q=' + encodeURIComponent(title))
  assert.ok(search.list.some(item => item.id === copied.id), '提交后副本应建立搜索索引')
  await api(origin, owner.token, '/doc/' + source.id + '/collaborators/' + member.user.id, 'DELETE')
  await api(peer, member.token, '/doc/' + source.id + '/copy', 'POST', {}, 403)
  await api(origin, owner.token, '/doc/' + source.id, 'DELETE')
  records[0].deleted = true
  await api(peer, owner.token, '/doc/' + source.id + '/copy', 'POST', {}, 404)
  assert.equal((await api(origin, member.token, '/doc/' + copied.id)).revision, 1)
  console.log(JSON.stringify({ docIds: records.map(record => record.id), origin, peer,
    fullBodyOverImportLimit: true, readOnlyToPrivateCopy: true, revisionZeroSnapshot: true,
    independentEditing: true, forbiddenRevokedDeleted: true, sourceRevision: 1 }))
} finally {
  for (const socket of sockets) socket.close()
  for (const record of records) {
    if (record.deleted) continue
    const detail = await api(origin, record.token, '/doc/' + record.id)
    assert.equal(detail.ownerId, record.ownerId); assert.equal(detail.title, record.title)
    const collaborators = await api(origin, record.token, '/doc/' + record.id + '/collaborators')
    for (const collaborator of collaborators) await api(origin, record.token, '/doc/' + record.id + '/collaborators/' + collaborator.userId, 'DELETE')
    await api(origin, record.token, '/doc/' + record.id, 'DELETE')
    record.deleted = true
  }
}
