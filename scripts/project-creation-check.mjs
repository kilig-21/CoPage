import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'

// 仅用于调用方建立的隔离生产栈；账号/令牌留在内存，不输出请求体或凭据。
function client(port) {
  const tokens = new Map()
  return async (credentials, path, method = 'GET', body, expected = 200, key, target = port) => {
    let token = tokens.get(credentials.username)
    if (!token) {
      const login = await fetch(`http://127.0.0.1:${target}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials),
        signal: AbortSignal.timeout(15000),
      })
      assert.equal(login.status, 200, '项目创建验收账号登录失败')
      const payload = await login.json(); assert.equal(payload.code, 0)
      token = payload.data.token; tokens.set(credentials.username, token)
    }
    const response = await fetch(`http://127.0.0.1:${target}/api${path}`, {
      method, signal: AbortSignal.timeout(15000),
      headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(key ? { 'Idempotency-Key': key } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    assert.equal(response.status, expected, `${method} ${path} HTTP状态不符`)
    const payload = await response.json()
    if (expected === 200) assert.equal(payload.code, 0, `${method} ${path}业务拒绝`)
    return payload.data
  }
}

export const projectCreationSnapshotSql = 'SELECT user_id,request_id,request_hash,project_id,group_id,create_time FROM project_creation_receipt ORDER BY user_id,request_id;'
const projectCountSql = 'SELECT COUNT(*) FROM copage_project;'
const receiptSql = (userId, key) => `SELECT user_id,request_id,request_hash,project_id,group_id,create_time FROM project_creation_receipt WHERE user_id=${userId} AND request_id='${key}';`

export async function createProjectCreationFixture({ port, peerPort, owner, viewer, sql }) {
  assert.ok(Number.isInteger(port) && Number.isInteger(peerPort) && port !== peerPort, '项目并发验收需要两个独立后端端口')
  assert.equal(typeof sql, 'function', '项目创建验收须使用隔离库SQL核对')
  const api = client(port), marker = '项目创建验收-' + randomBytes(6).toString('hex'), requests = []
  const ownerProfile = await api(owner, '/account/me'), viewerProfile = await api(viewer, '/account/me')
  const inboxBefore = await api(viewer, '/groups/invitations')
  const documentReceiptsBefore = sql('SELECT COUNT(*) FROM doc_creation_receipt;').trim()
  const remember = async (credentials, userId, body, key = randomUUID()) => {
    const responses = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      api(credentials, '/projects', 'POST', body, 200, index % 2 ? key.toUpperCase() : key, index % 2 ? peerPort : port)))
    const result = responses[0]
    assert.ok(Number.isSafeInteger(result.id) && result.id > 0)
    assert.equal(result.groupId, body.groupId)
    for (const value of responses) assert.deepEqual(value, result, '跨后端并发必须返回同一原项目编号')
    const nameHex = Buffer.from(body.name, 'utf8').toString('hex').toUpperCase()
    assert.equal(sql(`SELECT COUNT(*) FROM copage_project WHERE owner_id=${userId} AND group_id=${body.groupId} AND HEX(name)='${nameHex}';`).trim(), '1', '并发请求只能创建一个项目')
    const receipt = sql(receiptSql(userId, key)).trim()
    assert.ok(receipt, '成功创建必须保存项目回执')
    assert.equal(sql(`SELECT COUNT(*) FROM project_creation_receipt WHERE user_id=${userId} AND request_id='${key}' AND project_id=${result.id} AND group_id=${body.groupId};`).trim(), '1')
    const entry = { credentials, userId, body: { ...body }, key, result, receipt }
    requests.push(entry)
    return entry
  }
  const replay = async (entry, expected = 200) => {
    const before = sql(projectCountSql).trim()
    const result = await api(entry.credentials, '/projects', 'POST', entry.body, expected, entry.key, peerPort)
    if (expected === 200) assert.deepEqual(result, entry.result, '重试不能返回替代项目')
    assert.equal(sql(projectCountSql).trim(), before, '重试或权限拒绝不得创建额外项目')
    assert.equal(sql(receiptSql(entry.userId, entry.key)).trim(), entry.receipt, '重试或权限拒绝须保留原成功回执全部字段')
  }
  const rejectFresh = async (credentials, userId, body, expected) => {
    const key = randomUUID(), before = sql(projectCountSql).trim()
    await api(credentials, '/projects', 'POST', body, expected, key)
    assert.equal(sql(projectCountSql).trim(), before, '创建失败不得留下项目')
    assert.equal(sql(`SELECT COUNT(*) FROM project_creation_receipt WHERE user_id=${userId} AND request_id='${key}';`).trim(), '0', '创建失败必须回滚占位回执')
  }

  // 相同UUID和资料在不同可信账号下各创建一篇个人项目。
  const sharedKey = randomUUID(), personalBody = { name: marker + '-个人', description: '原提交中文😀', groupId: 0 }
  const personal = await remember(owner, ownerProfile.id, personalBody, sharedKey)
  const viewerPersonal = await remember(viewer, viewerProfile.id, personalBody, sharedKey)
  assert.notEqual(personal.result.id, viewerPersonal.result.id)
  await api(viewer, '/projects/' + personal.result.id + '/state', 'GET', undefined, 403)
  await api(owner, '/projects/' + viewerPersonal.result.id + '/state', 'GET', undefined, 403)
  for (const changed of [
    { ...personalBody, name: marker + '-不同' }, { ...personalBody, description: '不同简介' }, { ...personalBody, groupId: 1 },
  ]) {
    const before = sql(projectCountSql).trim()
    await api(owner, '/projects', 'POST', changed, 400, sharedKey)
    assert.equal(sql(projectCountSql).trim(), before)
    assert.equal(sql(receiptSql(ownerProfile.id, sharedKey)).trim(), personal.receipt)
  }
  await rejectFresh(owner, ownerProfile.id, { name: ' ', description: '', groupId: 0 }, 400)
  const invalidBefore = sql(projectCountSql).trim()
  await api(owner, '/projects', 'POST', personalBody, 400, 'invalid-key')
  assert.equal(sql(projectCountSql).trim(), invalidBefore)

  // 新小组独立于组织恢复fixture；邀请立即接受，不留下viewer未接受邀请。
  const group = await api(owner, '/groups', 'POST', { name: marker + '-权限组', description: '只测创建回执权限' })
  const join = async () => {
    await api(owner, '/groups/' + group.id + '/invitations', 'POST', { username: viewer.username })
    const invitation = (await api(viewer, '/groups/invitations')).list.find(value => value.groupId === group.id)
    assert.ok(invitation)
    await api(viewer, '/groups/' + group.id + '/invitation', 'POST', { accept: true, invitationVersion: invitation.invitationVersion })
  }
  await join()
  await api(owner, '/groups/' + group.id + '/members/' + viewerProfile.id, 'PUT', { role: 'admin' })
  const grouped = await remember(viewer, viewerProfile.id, { name: marker + '-小组', description: '冻结原资料', groupId: group.id })
  for (const entry of [personal, grouped]) {
    await api(entry.credentials, '/projects/' + entry.result.id, 'PUT', { name: entry.body.name + '-已改名', description: '当前简介' })
    await api(entry.credentials, '/projects/' + entry.result.id + '/archive', 'POST', {})
    const state = await api(entry.credentials, '/projects/' + entry.result.id + '/state')
    assert.equal(state.id, entry.result.id); assert.equal(state.groupId, entry.body.groupId)
    assert.equal(state.name, entry.body.name + '-已改名'); assert.equal(state.description, '当前简介'); assert.equal(state.archived, true)
    await replay(entry)
    assert.deepEqual(await api(entry.credentials, '/projects/' + entry.result.id + '/state'), state, '原创建重放不能覆盖改名或恢复归档项目')
  }
  await api(owner, '/groups/' + group.id + '/members/' + viewerProfile.id, 'PUT', { role: 'member' })
  assert.equal((await api(viewer, '/projects/' + grouped.result.id + '/state')).canManage, false)
  await replay(grouped)
  await rejectFresh(viewer, viewerProfile.id, { ...grouped.body, name: marker + '-降权禁止新建' }, 403)
  await api(viewer, '/groups/' + group.id + '/leave', 'POST', {})
  await replay(grouped, 403)
  await rejectFresh(viewer, viewerProfile.id, { ...grouped.body, name: marker + '-退组禁止新建' }, 403)
  await join()
  await replay(grouped)
  await api(owner, '/groups/' + group.id + '/archive', 'POST', {})
  await replay(grouped, 404)
  await rejectFresh(owner, ownerProfile.id, { ...grouped.body, name: marker + '-归档组禁止新建' }, 404)
  // 备份前恢复本轮小组，保留组织fixture“只有其原归档组”的断言。
  await api(owner, '/groups/' + group.id + '/restore', 'POST', {})
  await replay(grouped)
  assert.deepEqual(await api(viewer, '/groups/invitations'), inboxBefore, '本轮不新增未接受邀请')
  for (const entry of requests) entry.state = await api(entry.credentials, '/projects/' + entry.result.id + '/state')
  assert.equal(sql('SELECT COUNT(*) FROM project_creation_receipt WHERE project_id<=0;').trim(), '0')
  assert.equal(sql('SELECT COUNT(*) FROM doc_creation_receipt;').trim(), documentReceiptsBefore, '项目创建不能写入文档创建回执')
  console.log('PASS: 项目跨双后端并发单项目、UUID账号隔离/资料冲突、失败占位回滚、改名归档重放及降权/退组/归档组当前权限')
  return { requests, group, owner, viewer }
}

export async function verifyProjectCreationRecovery({ port, fixture, sql }) {
  assert.equal(typeof sql, 'function')
  const api = client(port), beforeProjects = sql(projectCountSql).trim(), beforeReceipts = sql(projectCreationSnapshotSql).trim()
  for (const entry of fixture.requests) {
    assert.deepEqual(await api(entry.credentials, '/projects', 'POST', entry.body, 200, entry.key), entry.result)
    assert.deepEqual(await api(entry.credentials, '/projects/' + entry.result.id + '/state'), entry.state, '恢复须保留当前归属、资料、归档及权限')
    assert.equal(sql(receiptSql(entry.userId, entry.key)).trim(), entry.receipt)
  }
  assert.equal(sql(projectCountSql).trim(), beforeProjects, '恢复后原标识重试不得新增项目')
  assert.equal(sql(projectCreationSnapshotSql).trim(), beforeReceipts, '恢复核对不得新增或改变项目创建回执')
  // 此阶段不降权/退出/归档/恢复任何组织；由调用方再逐行检查组织fixture未变。
  console.log('PASS: SQL/新卷恢复后项目原UUID返回原编号，改名/归档/成员状态保持，项目及回执无新增')
}
