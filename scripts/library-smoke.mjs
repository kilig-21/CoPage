import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const origin = process.env.COPAGE_LIBRARY_ORIGIN || 'http://localhost:8080'
const marker = 'Library-' + randomUUID()
const records = []
async function api(token, path, method = 'GET', body, status = 200) {
  const response = await fetch(origin + '/api' + path, {
    method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000),
  })
  const result = await response.json()
  assert.equal(response.status, status, method + ' ' + path + ': ' + result.message)
  if (status === 200) assert.equal(result.code, 0)
  return result.data
}
async function create(account, suffix) {
  const title = marker + suffix
  const doc = await api(account.token, '/doc', 'POST', { title })
  const record = { id: doc.id, title, account, deleted: false }
  records.push(record)
  return record
}
const list = (account, scope = 'all', page = 1, keyword = marker) => api(account.token,
  '/doc/list?' + new URLSearchParams({ scope, page, size: 20, keyword }))
try {
  await api(null, '/doc/list', 'GET', undefined, 401)
  const a = await api(null, '/auth/login', 'POST', { username: 'testA', password: '123456' })
  const b = await api(null, '/auth/login', 'POST', { username: 'testB', password: '123456' })
  const owned = []
  for (let i = 0; i < 21; i++) owned.push(await create(a, '-own-' + i))
  const read = await create(b, '-read'), edit = await create(b, '-edit'), privateDoc = await create(b, '-private')
  await api(b.token, '/doc/' + read.id + '/collaborators', 'POST', { username: 'testA', permission: 1 })
  await api(b.token, '/doc/' + edit.id + '/collaborators', 'POST', { username: 'testA', permission: 2 })
  await api(a.token, '/doc/' + owned[0].id + '/collaborators', 'POST', { username: 'testB', permission: 2 })
  const all = await list(a), first = await list(a, 'owned'), second = await list(a, 'owned', 2), shared = await list(a, 'shared')
  assert.equal(all.total, 23); assert.equal(first.total, 21); assert.equal(first.list.length, 20)
  assert.equal(second.total, 21); assert.equal(second.list.length, 1)
  assert.deepEqual(new Set([...first.list, ...second.list].map(doc => doc.id)), new Set(owned.map(doc => doc.id)))
  assert.ok([...first.list, ...second.list].every(doc => doc.isOwner && doc.permission === 2))
  assert.equal(shared.total, 2)
  assert.deepEqual(new Map(shared.list.map(doc => [doc.id, doc.permission])), new Map([[read.id, 1], [edit.id, 2]]))
  assert.ok(shared.list.every(doc => !doc.isOwner))
  assert.ok(!all.list.some(doc => doc.id === privateDoc.id))
  assert.ok(all.list.every(doc => !('content' in doc) && !('revision' in doc)))
  assert.equal((await list(a, 'shared', 1, read.title)).total, 1)
  assert.equal((await list(a, 'owned', 1, read.title)).total, 0)
  const bShared = await list(b, 'shared')
  assert.equal(bShared.total, 1); assert.equal(bShared.list[0].id, owned[0].id)
  assert.equal((await list(b, 'owned')).total, 3)
  const defaultScope = await api(a.token, '/doc/list?' + new URLSearchParams({ keyword: marker }))
  assert.equal(defaultScope.total, all.total)
  await api(a.token, '/doc/list?scope=unknown', 'GET', undefined, 400)
  await api(a.token, '/doc/list?' + new URLSearchParams({ keyword: '名'.repeat(201) }), 'GET', undefined, 400)
  await api(a.token, '/doc/list?size=101', 'GET', undefined, 400)
  assert.equal((await list(a, 'owned', 1000000)).list.length, 0)
  await api(b.token, '/doc/' + read.id + '/collaborators/' + a.user.id, 'PUT', { permission: 2 })
  assert.equal((await list(a, 'shared')).list.find(doc => doc.id === read.id).permission, 2)
  await api(b.token, '/doc/' + read.id + '/collaborators/' + a.user.id, 'DELETE')
  assert.equal((await list(a, 'shared')).total, 1)
  await api(b.token, '/doc/' + edit.id + '/collaborators/' + a.user.id, 'DELETE')
  await api(b.token, '/doc/' + edit.id, 'DELETE'); edit.deleted = true
  assert.equal((await list(a, 'shared')).total, 0)
  console.log(JSON.stringify({ origin, docIds: records.map(doc => doc.id), pagination: '21 owned / 2 pages',
    categories: true, currentPermissions: true, privateAndDeletedHidden: true, summaryOnly: true }))
} finally {
  for (const record of records) {
    // 只清理本轮唯一标题、指定所有者、从未编辑的合成文档。
    const detail = record.deleted ? null : await api(record.account.token, '/doc/' + record.id)
    if (detail) {
      assert.equal(detail.ownerId, record.account.user.id); assert.equal(detail.title, record.title); assert.equal(detail.revision, 0)
    }
    const members = record.deleted ? [] : await api(record.account.token, '/doc/' + record.id + '/collaborators')
    for (const member of members) await api(record.account.token, '/doc/' + record.id + '/collaborators/' + member.userId, 'DELETE')
    if (!record.deleted) await api(record.account.token, '/doc/' + record.id, 'DELETE')
  }
}
