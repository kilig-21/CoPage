import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// 仅在已有本地开发库运行；所有凭据只在进程内存，测试资料按身份与完整内容守卫清理。
const root = fileURLToPath(new URL('../', import.meta.url))
const ports = [Number(process.env.COPAGE_TIME_PORT_A || 8080), Number(process.env.COPAGE_TIME_PORT_B || 8082)]
assert.ok(ports.every(port => Number.isInteger(port) && port > 0 && port <= 65535))
assert.notEqual(ports[0], ports[1], '时间烟测需要两个独立实例')
const marker = 'timeqa' + randomBytes(8).toString('hex')
const owner = { username: marker + 'a', password: randomBytes(24).toString('hex') }
const peer = { username: marker + 'b', password: randomBytes(24).toString('hex') }
const tokens = new Map(), fixtures = { projects: [] }

function sql(statement) {
  const result = spawnSync('docker', ['compose', 'exec', '-T', 'mysql', 'sh', '-c',
    'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql --default-character-set=utf8mb4 -N -B -uroot collab_doc'],
  { cwd: root, input: statement, encoding: 'utf8', timeout: 15000, windowsHide: true })
  assert.equal(result.status, 0, '本地数据库只读核对失败')
  return result.stdout.trim()
}
async function api(credentials, port, path, method = 'GET', body, expected = 200) {
  const token = tokens.get(credentials.username)
  const response = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method, signal: AbortSignal.timeout(15000),
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  assert.equal(response.status, expected, `${method} ${path} HTTP状态不符`)
  const value = await response.json()
  if (expected === 200) assert.equal(value.code, 0, `${method} ${path}业务拒绝`)
  return value.data
}
async function both(credentials, path) {
  const values = await Promise.all(ports.map(port => api(credentials, port, path)))
  assert.deepEqual(values[0], values[1], `${path}的双实例响应不一致`)
  return values[0]
}
function storedTime(table, column, where) {
  const value = sql(`SELECT DATE_FORMAT(${column},'%Y-%m-%d %H:%i:%s') FROM ${table} WHERE ${where};`)
  assert.match(value, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  return value
}

async function cleanup() {
  const failures = []
  const guarded = async (label, action) => {
    try { await action() } catch { failures.push(label) }
  }
  if (fixtures.template) await guarded('私人模板', async () => {
    const t = await api(owner, ports[0], '/personal-templates/' + fixtures.template.id)
    assert.equal(t.name, marker); assert.equal(t.version, 1); assert.equal(t.sourceRevision, 0)
    assert.deepEqual(t.content, fixtures.document.content)
    await api(owner, ports[0], `/personal-templates/${t.id}?expectedVersion=1`, 'DELETE')
  })
  for (const project of fixtures.projects) await guarded('项目' + project.id, async () => {
    const p = await api(owner, ports[0], '/projects/' + project.id)
    assert.equal(p.name, project.name); assert.equal(p.ownerId, fixtures.ownerId); assert.equal(p.groupId, project.groupId)
    await api(owner, ports[0], '/projects/' + p.id + '/archive', 'POST')
  })
  if (fixtures.group) await guarded('小组', async () => {
    const g = await api(owner, ports[0], '/groups/' + fixtures.group.id)
    assert.equal(g.name, marker); assert.equal(g.ownerId, fixtures.ownerId)
    assert.deepEqual(g.members.map(m => [m.userId, m.role]), [[fixtures.ownerId, 'owner']])
    assert.ok(g.invitations.every(i => i.userId === fixtures.peerId))
    await api(owner, ports[0], '/groups/' + g.id + '/archive', 'POST')
  })
  if (fixtures.document) await guarded('文档', async () => {
    const d = await api(owner, ports[0], '/doc/' + fixtures.document.id)
    assert.equal(d.title, marker); assert.equal(d.ownerId, fixtures.ownerId); assert.equal(d.revision, 0)
    assert.deepEqual(d.content, fixtures.document.content)
    assert.deepEqual(await api(owner, ports[0], `/doc/${d.id}/collaborators`), [])
    await api(owner, ports[0], '/doc/' + d.id, 'DELETE')
  })
  assert.deepEqual(failures, [], '清理守卫未通过，保留对应测试资料供排查')
  console.log('CLEANUP: 本轮文档仅软删除，小组/项目仅归档；账号、原关联和数据卷保留')
}

try {
  for (const credentials of [owner, peer]) {
    await api(credentials, ports[0], '/auth/register', 'POST', credentials)
    const login = await api(credentials, ports[0], '/auth/login', 'POST', credentials)
    tokens.set(credentials.username, login.token)
    fixtures[credentials === owner ? 'ownerId' : 'peerId'] = login.user.id
  }
  const created = await api(owner, ports[0], '/doc', 'POST', { title: marker, templateId: 'notes' })
  fixtures.document = await api(owner, ports[0], '/doc/' + created.id)
  fixtures.group = await api(owner, ports[0], '/groups', 'POST', { name: marker })
  await api(owner, ports[0], `/groups/${fixtures.group.id}/invitations`, 'POST', { username: peer.username })
  for (const groupId of [0, fixtures.group.id]) {
    const name = marker + (groupId ? '-group' : '-personal')
    const project = await api(owner, ports[0], '/projects', 'POST', { name, groupId })
    fixtures.projects.push({ ...project, name })
    await api(owner, ports[0], `/projects/${project.id}/documents`, 'POST', { docId: created.id })
  }
  fixtures.template = await api(owner, ports[0], '/personal-templates', 'POST', { docId: created.id, name: marker, category: 'planning' })
  const documentTime = storedTime('document', 'update_time', `id=${created.id}`)
  assert.equal((await both(owner, '/doc/' + created.id)).updateTime, documentTime)
  assert.equal((await both(owner, `/doc/${created.id}/metadata`)).updateTime, documentTime)
  assert.equal((await both(owner, '/doc/list')).list.find(d => d.id === created.id).updateTime, documentTime)
  assert.equal((await both(owner, '/doc/workbench')).recent.find(d => d.id === created.id).updateTime, documentTime)
  const groupTime = storedTime('copage_group', 'update_time', `id=${fixtures.group.id}`)
  assert.equal((await both(owner, '/groups')).list.find(g => g.id === fixtures.group.id).updateTime, groupTime)
  const group = await both(owner, '/groups/' + fixtures.group.id)
  assert.equal(group.members[0].joinedAt, storedTime('group_member', 'joined_at', `group_id=${group.id} AND user_id=${fixtures.ownerId}`))
  const invitationTime = storedTime('group_invitation', 'create_time', `group_id=${group.id} AND user_id=${fixtures.peerId}`)
  assert.equal(group.invitations[0].createdAt, invitationTime)
  assert.equal((await both(peer, '/groups/invitations')).list[0].createdAt, invitationTime)
  assert.equal((await both(peer, '/workspace/overview')).invitations[0].createdAt, invitationTime)
  for (const project of fixtures.projects) {
    assert.equal((await both(owner, '/projects')).list.find(p => p.id === project.id).updateTime,
      storedTime('copage_project', 'update_time', `id=${project.id}`))
    assert.equal((await both(owner, '/projects/' + project.id)).list[0].updateTime, documentTime)
  }
  assert.equal((await both(owner, '/personal-templates')).list[0].updateTime,
    storedTime('personal_template', 'update_time', `id=${fixtures.template.id}`))
  await api(owner, ports[0], '/doc/' + created.id, 'DELETE')
  fixtures.documentDeleted = true
  assert.equal((await both(owner, '/doc/trash')).list[0].deletedAt, storedTime('document', 'update_time', `id=${created.id}`))
  for (const port of ports) await api(owner, port, '/doc/' + created.id, 'GET', undefined, 404)
  await api(owner, ports[1], `/doc/${created.id}/restore`, 'POST')
  fixtures.documentDeleted = false
  const restored = await both(owner, '/doc/' + created.id)
  assert.equal(restored.revision, 0); assert.deepEqual(restored.content, fixtures.document.content)
  assert.equal(restored.updateTime, storedTime('document', 'update_time', `id=${created.id}`))
  for (const port of ports) await api(peer, port, '/doc/' + created.id, 'GET', undefined, 403)
  console.log(`PASS: 双实例各类时间与MySQL原值一致，正文/版本/权限保留；owner=${fixtures.ownerId} peer=${fixtures.peerId} doc=${created.id} group=${group.id} projects=${fixtures.projects.map(p => p.id)} template=${fixtures.template.id}`)
} finally {
  // 发生删除后的验证失败时，恢复仅本轮身份/标题/版本守卫通过的资料以便完成后续清理。
  if (fixtures.documentDeleted) {
    const state = sql(`SELECT owner_id,HEX(title),revision,is_deleted FROM document WHERE id=${fixtures.document.id};`).split('\t')
    assert.deepEqual(state, [String(fixtures.ownerId), Buffer.from(marker).toString('hex').toUpperCase(), '0', '1'])
    await api(owner, ports[0], `/doc/${fixtures.document.id}/restore`, 'POST')
  }
  await cleanup()
}
