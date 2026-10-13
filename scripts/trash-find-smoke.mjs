import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openRecoveryChannel } from './recovery-channel.mjs'

// default profile本机验收；阶段模式可将同批合成资料交给原生页面验证。
const action = process.argv[2] || 'all'
const statePath = process.argv[3] || join(tmpdir(), 'copage-trash-find-' + randomUUID() + '.json')
const origin = process.env.COPAGE_TRASH_ORIGIN || 'http://localhost:8080'
assert.ok(['all', 'prepare', 'verify', 'inspect', 'cleanup'].includes(action))
const hash = content => createHash('sha256').update(JSON.stringify(content)).digest('hex')
const accounts = {}
let state
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2))
async function api(account, path, method = 'GET', body, status = 200, key) {
  if (account && !accounts[account]) {
    accounts[account] = await api(null, '/auth/login', 'POST', { username: account, password: '123456' })
    assert.equal(accounts[account].user.id, account === 'testA' ? 1 : 2)
  }
  const form = body instanceof FormData
  const response = await fetch(origin + '/api' + path, { method, signal: AbortSignal.timeout(30000),
    headers: { ...(account ? { Authorization: 'Bearer ' + accounts[account].token } : {}),
      ...(body && !form ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
    body: form ? body : body ? JSON.stringify(body) : undefined })
  const result = await response.json()
  assert.equal(response.status, status, `${method} ${path}: ${result.message}`)
  if (status === 200) assert.equal(result.code, 0)
  return result.data
}
async function create(account, title, body, kind) {
  const content = { ops: [{ insert: body + '\n' }] }
  const record = { id: null, account, title, kind, content, hash: hash(content), revision: 0, members: [] }
  state.records.push(record); save() // 计划正文先于发送；未知创建不跳过守卫。
  const form = new FormData()
  form.append('file', new Blob([JSON.stringify({ format: 'copage', version: 1, title, content })]), 'trash-fixture.copage.json')
  form.append('title', title)
  record.requestId = randomUUID(); save()
  const created = await api(account, '/doc/import', 'POST', form, 200, record.requestId)
  assert.ok(Number.isSafeInteger(created.id) && created.id > 0 && created.id !== 26 && !state.records.some(r => r.id === created.id))
  record.id = created.id; save()
  const detail = await api(account, '/doc/' + record.id)
  assert.equal(detail.ownerId, account === 'testA' ? 1 : 2)
  assert.equal(detail.title, record.title)
  assert.deepEqual(detail.content, content)
  return record
}
async function prepare() {
  assert.ok(!existsSync(statePath), '已有验收记录，先核对原批次，不能覆盖')
  state = { marker: 'TrashFind-' + randomUUID(), records: [] }; save()
  for (let n = 1; n <= 22; n++) {
    const title = state.marker + (n === 21 ? '-22-AB资料' : '-' + String(n).padStart(2, '0') + (n === 22 ? '-%_资料' : ''))
    const record = await create('testA', title, '保留正文-' + n, 'match')
    if (n === 1) {
      record.members = [{ userId: 2, permission: 1 }]; save()
      await api('testA', '/doc/' + record.id + '/collaborators', 'POST', { username: 'testB', permission: 1 })
      let channel
      try {
        channel = await openRecoveryChannel({ url: origin.replace(/^http/, 'ws') + '/ws/collab?token=' + encodeURIComponent(accounts.testA.token),
          docId: record.id, clientId: randomUUID(), lastRevision: 0, phase: 'test' })
        record.content = { ops: [{ insert: '恢复查找验收|' + record.content.ops[0].insert }] }
        record.hash = hash(record.content); record.revision = 1; save()
        assert.equal((await channel.submit(randomUUID(), 0, { ops: [{ insert: '恢复查找验收|' }] })).revision, 1)
      } finally { channel?.ws.close() }
    }
    await api('testA', '/doc/' + record.id, 'DELETE')
  }
  await create('testA', state.marker + '-active', '未删除正文', 'active')
  const other = await create('testB', state.marker + '-other-owner', '他人正文', 'other')
  await api('testB', '/doc/' + other.id, 'DELETE')
  const bodyOnly = await create('testA', '正文候选-' + state.marker.slice(-12), state.marker, 'body-only')
  await api('testA', '/doc/' + bodyOnly.id, 'DELETE')
  console.log(JSON.stringify({ stage: 'prepared', marker: state.marker, ids: state.records.map(r => r.id), statePath }))
}
async function verify() {
  const query = keyword => '/doc/trash?size=20&keyword=' + encodeURIComponent(keyword)
  const matches = state.records.filter(r => r.kind === 'match')
  await api(null, query(state.marker), 'GET', undefined, 401)
  await api('testA', query('中'.repeat(201)), 'GET', undefined, 400)
  await api('testA', query('中'.repeat(200)))
  await api('testA', query(state.marker) + '&page=0', 'GET', undefined, 400)
  await api('testA', '/doc/trash?size=101', 'GET', undefined, 400)
  const first = await api('testA', query('  ' + state.marker + '  '))
  const second = await api('testA', query(state.marker) + '&page=2')
  assert.equal(first.total, 22); assert.equal(second.total, 22)
  assert.equal(first.list.length, 20); assert.equal(second.list.length, 2)
  assert.deepEqual([...first.list, ...second.list].map(r => r.id), matches.map(r => r.id).reverse())
  for (const row of [...first.list, ...second.list]) assert.deepEqual(Object.keys(row).sort(), ['deletedAt', 'id', 'title'])
  assert.deepEqual((await api('testA', query(state.marker + '-22-%_'))).list.map(r => r.id), [matches[21].id])
  assert.equal((await api('testA', query(state.marker + '-不存在'))).total, 0)
  assert.deepEqual((await api('testB', query(state.marker))).list.map(r => r.id), [state.records.find(r => r.kind === 'other').id])
  await api('testB', '/doc/' + matches[0].id + '/restore', 'POST', undefined, 404)
  const legacy = await api('testA', '/doc/trash?size=20')
  assert.ok(legacy.total >= 22)
  assert.equal((await api('testA', query('   '))).total, legacy.total)
  console.log(JSON.stringify({ stage: 'verified', marker: state.marker, ownerOnly: true, titleOnly: true,
    literalSymbols: true, trimmedKeyword: true, stablePagination: true, noContentProjection: true }))
}
function inspect() {
  assert.ok(state.records.length && state.records.every(r => Number.isSafeInteger(r.id) && r.id > 0 && r.id !== 26) &&
    new Set(state.records.map(r => r.id)).size === state.records.length, '未知或重复创建记录保留，不能自动清理')
  const ids = state.records.map(r => r.id).join(',')
  const sql = `SELECT JSON_OBJECT('id',d.id,'ownerId',d.owner_id,'title',d.title,'deleted',d.is_deleted,'revision',d.revision,'content',d.content,'ops',(SELECT COUNT(*) FROM doc_operation o WHERE o.doc_id=d.id),'receipts',(SELECT COUNT(*) FROM doc_operation_receipt o WHERE o.doc_id=d.id),'members',(SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('userId',c.user_id,'permission',c.permission)),JSON_ARRAY()) FROM doc_collaborator c WHERE c.doc_id=d.id),'projects',(SELECT COUNT(*) FROM project_document p WHERE p.doc_id=d.id)) FROM document d WHERE d.id IN(${ids})`
  const raw = execFileSync('docker', ['exec', 'collab-mysql', 'sh', '-c',
    'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysql --default-character-set=utf8mb4 --user=root --batch --raw --skip-column-names collab_doc -e "$1"', 'trash-fixture', sql], { encoding: 'utf8' })
  const rows = raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.equal(rows.length, state.records.length)
  for (const record of state.records) {
    const row = rows.find(r => r.id === record.id)
    assert.equal(row.ownerId, record.account === 'testA' ? 1 : 2); assert.equal(row.title, record.title)
    assert.equal(row.revision, record.revision); assert.equal(row.ops, record.revision); assert.equal(row.receipts, record.revision)
    assert.equal(hash(JSON.parse(row.content)), record.hash); assert.deepEqual(row.members, record.members); assert.equal(row.projects, 0)
  }
  return rows
}
async function cleanup() {
  const rows = inspect() // 全批计划正文/归属/操作/成员守卫通过后才开始清理。
  for (const record of state.records) {
    const row = rows.find(r => r.id === record.id)
    if (record.members.length) {
      if (row.deleted) await api(record.account, '/doc/' + record.id + '/restore', 'POST')
      for (const member of record.members) await api(record.account, '/doc/' + record.id + '/collaborators/' + member.userId, 'DELETE')
      record.members = []; save()
      await api(record.account, '/doc/' + record.id, 'DELETE')
    } else if (!row.deleted) await api(record.account, '/doc/' + record.id, 'DELETE')
  }
  assert.ok(inspect().every(r => r.deleted === 1))
  console.log(JSON.stringify({ stage: 'cleaned', ids: state.records.map(r => r.id), softDeleted: true, contentsPreserved: true }))
}
if (action === 'prepare') await prepare()
else if (action === 'all') {
  let failure
  try { await prepare(); await verify() } catch (error) { failure = error }
  try { if (state?.records.length) await cleanup() }
  catch (cleanupFailure) {
    throw failure ? new AggregateError([failure, cleanupFailure], '验收失败且清理未完成；原根因与守卫异常均保留') : cleanupFailure
  }
  if (failure) throw failure
} else {
  state = JSON.parse(readFileSync(statePath))
  if (action === 'verify') await verify()
  else if (action === 'inspect') {
    const rows = inspect()
    console.log(JSON.stringify({ stage: 'inspected', documents: rows.length, deleted: rows.filter(r => r.deleted === 1).length, guardsPassed: true }))
  }
  else await cleanup()
}
