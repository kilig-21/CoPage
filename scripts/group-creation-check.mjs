import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'

// 仅供调用方创建的隔离生产栈使用；本文件不启动运行栈，也不保存或输出凭据。
function client(port) {
  const tokens = new Map()
  return async (credentials, path, method = 'GET', body, expected = 200, key, target = port) => {
    let token = tokens.get(credentials.username)
    if (!token) {
      const response = await fetch(`http://127.0.0.1:${target}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials),
        signal: AbortSignal.timeout(15000),
      })
      assert.equal(response.status, 200, '小组创建验收账号登录失败')
      const payload = await response.json()
      assert.equal(payload.code, 0)
      assert.equal(typeof payload.data.token, 'string')
      token = payload.data.token; tokens.set(credentials.username, token)
    }
    const response = await fetch(`http://127.0.0.1:${target}/api${path}`, {
      method, signal: AbortSignal.timeout(15000),
      headers: { Authorization: 'Bearer ' + token, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(key !== undefined ? { 'Idempotency-Key': key } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    assert.equal(response.status, expected, `${method} ${path} HTTP状态不符`)
    const payload = await response.json()
    if (expected === 200) assert.equal(payload.code, 0, `${method} ${path}业务拒绝`)
    else assert.notEqual(payload.code, 0, '拒绝响应不得报告成功')
    return payload.data
  }
}

const receiptsSnapshotSql = 'SELECT user_id,request_id,request_hash,group_id,create_time FROM group_creation_receipt ORDER BY user_id,request_id;'
const groupStateSql = [
  'SELECT id,HEX(name),HEX(description),owner_id,is_archived,create_time,update_time FROM copage_group ORDER BY id;',
  'SELECT group_id,user_id,role,joined_at FROM group_member ORDER BY group_id,user_id;',
  'SELECT group_id,user_id,inviter_id,status,invitation_version,create_time,update_time FROM group_invitation ORDER BY group_id,user_id;',
].join('\n')
// 关系和全部时间字段也属于创建恢复契约，不能只比较回执数或小组编号。
export const groupCreationSnapshotSql = groupStateSql + '\n' + receiptsSnapshotSql
const receiptSql = (userId, key) => `SELECT user_id,request_id,request_hash,group_id,create_time FROM group_creation_receipt WHERE user_id=${userId} AND request_id='${key}';`
const originalGroupSql = id => `SELECT id,HEX(name),HEX(description),owner_id,is_archived,create_time,update_time FROM copage_group WHERE id=${id};
  SELECT group_id,user_id,role,joined_at FROM group_member WHERE group_id=${id} ORDER BY user_id;
  SELECT group_id,user_id,inviter_id,status,invitation_version,create_time,update_time FROM group_invitation WHERE group_id=${id} ORDER BY user_id;`
const snapshot = sql => sql(groupCreationSnapshotSql).trim()
const hex = value => Buffer.from(value, 'utf8').toString('hex').toUpperCase()
const safeId = value => {
  assert.ok(Number.isSafeInteger(value) && value > 0, '隔离fixture编号必须为正安全整数')
  return value
}

const currentCreationView = (sql, entry) => {
  const fields = sql(`SELECT HEX(name),is_archived FROM copage_group WHERE id=${entry.result.id} AND owner_id=${entry.userId};`).trim().split('\t')
  assert.equal(fields.length, 2, '原小组及真实owner关系必须存在')
  assert.match(fields[0], /^(?:[0-9A-F]{2})+$/)
  assert.ok(fields[1] === '0' || fields[1] === '1')
  return { id: entry.result.id, name: Buffer.from(fields[0], 'hex').toString('utf8'), archived: fields[1] === '1' }
}

export async function createGroupCreationFixture({ port, peerPort, owner, viewer, sql, projectName }) {
  assert.match(projectName ?? '', /^copage-prod-qa-[0-9a-f]{12}$/, '故障注入只允许调用方已核对的随机隔离生产项目')
  assert.ok(Number.isInteger(port) && Number.isInteger(peerPort) && port !== peerPort, '小组并发验收需要两个独立后端端口')
  assert.equal(typeof sql, 'function', '小组创建验收须使用隔离库SQL核对')
  const api = client(port), marker = '小组创建验收-' + randomBytes(6).toString('hex'), requests = []
  const ownerProfile = await api(owner, '/account/me'), viewerProfile = await api(viewer, '/account/me')
  safeId(ownerProfile.id); safeId(viewerProfile.id); assert.notEqual(ownerProfile.id, viewerProfile.id)
  const inboxBefore = await api(viewer, '/groups/invitations')
  const unrelatedSql = `SELECT user_id,request_id,kind,request_hash,doc_id,HEX(response_json),create_time FROM doc_creation_receipt ORDER BY user_id,request_id;
    SELECT user_id,request_id,request_hash,project_id,group_id,create_time FROM project_creation_receipt ORDER BY user_id,request_id;`
  const unrelatedBefore = sql(unrelatedSql).trim()
  const remember = async (credentials, userId, body, key) => {
    const responses = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      api(credentials, '/groups', 'POST', body, 200, index % 2 ? key.toUpperCase() : key, index % 2 ? peerPort : port)))
    const result = responses[0]
    safeId(result.id); assert.equal(result.name, body.name); assert.equal(result.archived, false)
    for (const response of responses) assert.deepEqual(response, result, '双后端同UUID并发须返回同一小组')
    assert.equal(sql(`SELECT COUNT(*) FROM copage_group WHERE owner_id=${userId} AND HEX(name)='${hex(body.name)}';`).trim(), '1')
    assert.equal(sql(`SELECT COUNT(*) FROM group_member WHERE group_id=${result.id};`).trim(), '1', '新组只能有实际创建者成员')
    assert.equal(sql(`SELECT COUNT(*) FROM group_member WHERE group_id=${result.id} AND user_id=${userId} AND role='owner';`).trim(), '1')
    assert.equal(sql(`SELECT COUNT(*) FROM group_creation_receipt WHERE user_id=${userId} AND request_id='${key}' AND group_id=${result.id};`).trim(), '1')
    const receipt = sql(receiptSql(userId, key)).trim()
    assert.ok(receipt)
    const entry = { credentials, userId, body: { ...body }, key, result, receipt }
    requests.push(entry)
    return entry
  }
  const replay = async entry => {
    const before = snapshot(sql)
    const current = currentCreationView(sql, entry)
    assert.deepEqual(await api(entry.credentials, '/groups', 'POST', entry.body, 200, entry.key, peerPort),
      current, '原请求须返回原id、当前名称与归档状态')
    assert.equal(snapshot(sql), before, '原创建确认不得改组、成员、邀请或任何回执')
    assert.equal(sql(receiptSql(entry.userId, entry.key)).trim(), entry.receipt)
  }
  const rejectFresh = async (body, key = randomUUID()) => {
    const before = snapshot(sql)
    await api(owner, '/groups', 'POST', body, 400, key)
    assert.equal(snapshot(sql), before, '无效创建须整体回滚小组、owner成员和占位回执')
  }

  // 即使请求包含伪造ownerId，可信账号也各自拥有一个组；同UUID不跨账号共用。
  const sharedKey = randomUUID(), body = { name: marker, description: '原提交中文😀\n简介', ownerId: viewerProfile.id }
  const own = await remember(owner, ownerProfile.id, body, sharedKey)
  const peer = await remember(viewer, viewerProfile.id, { ...body, ownerId: ownerProfile.id }, sharedKey)
  assert.notEqual(own.result.id, peer.result.id)
  await api(viewer, '/groups/' + own.result.id, 'GET', undefined, 403)
  await api(owner, '/groups/' + peer.result.id, 'GET', undefined, 403)
  for (const changed of [
    { ...body, name: marker + '-不同' }, { ...body, name: ' ' + body.name + ' ' },
    { ...body, description: '不同简介' }, { ...body, description: ' ' + body.description + ' ' },
    { ...body, description: null }, { ...body, description: '' },
  ]) {
    const before = snapshot(sql)
    await api(owner, '/groups', 'POST', changed, 400, sharedKey)
    assert.equal(snapshot(sql), before, '原字符串冲突不得更换回执或创建替代组')
  }
  for (const invalid of [
    { name: ' ', description: '' }, { name: null, description: '' },
    { name: '名'.repeat(81), description: '' }, { name: '非法\n名称', description: '' },
    { name: marker + '-简介超长', description: '简'.repeat(301) },
    { name: marker + '-简介控制符', description: '非法\u0000简介' },
  ]) await rejectFresh(invalid)
  for (const key of ['invalid-key', '', '1-1-1-1-1']) await rejectFresh(body, key)

  const anonymousBefore = snapshot(sql)
  const anonymous = await fetch(`http://127.0.0.1:${port}/api/groups`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  })
  assert.equal(anonymous.status, 401)
  assert.equal(snapshot(sql), anonymousBefore, '无可信身份不得创建或认领回执')

  for (const entry of requests) {
    await api(entry.credentials, '/groups/' + entry.result.id, 'PUT', { name: entry.body.name + '-已改名', description: '当前简介' })
    await replay(entry)
    await api(entry.credentials, '/groups/' + entry.result.id + '/archive', 'POST', {})
    await replay(entry)
    await api(entry.credentials, '/groups/' + entry.result.id, 'GET', undefined, 404)
    // owner恢复原组以保留组织fixture的唯一归档组断言；viewer自己的组保留归档，核对新卷归档重放。
    if (entry === own) {
      await api(entry.credentials, '/groups/' + entry.result.id + '/restore', 'POST', {})
      await replay(entry)
      const detail = await api(entry.credentials, '/groups/' + entry.result.id)
      assert.equal(detail.name, entry.body.name + '-已改名'); assert.equal(detail.description, '当前简介')
    }
  }

  // 所有异常仅构造精确随机临时回执，finally移除；不删除真实fixture小组。
  const brokenReceipt = async ({ credentials = owner, userId = ownerProfile.id, groupId, expected }) => {
    const key = randomUUID(), before = snapshot(sql)
    assert.equal(sql(`SELECT COUNT(*) FROM group_creation_receipt WHERE user_id=${userId} AND request_id='${key}';`).trim(), '0')
    const inserted = sql(`INSERT INTO group_creation_receipt(user_id,request_id,request_hash,group_id)
      SELECT ${userId},'${key}',request_hash,${groupId} FROM group_creation_receipt
      WHERE user_id=${own.userId} AND request_id='${own.key}'; SELECT ROW_COUNT();`).trim()
    assert.equal(inserted, '1')
    try {
      const corrupt = snapshot(sql)
      await api(credentials, '/groups', 'POST', own.body, expected, key, peerPort)
      assert.equal(snapshot(sql), corrupt, '坏回执拒绝须回滚占位变化，不补建或修复组')
    } finally {
      // UUID在本函数插入前明确不存在；即使待测代码错误改了group_id，也清理这个精确临时回执。
      assert.equal(sql(`DELETE FROM group_creation_receipt WHERE user_id=${userId} AND request_id='${key}'; SELECT ROW_COUNT();`).trim(), '1')
    }
    assert.equal(snapshot(sql), before, '临时坏回执清理后须还原全部组与回执资料')
  }
  await brokenReceipt({ groupId: 0, expected: 500 })
  await brokenReceipt({ groupId: -7, expected: 500 })
  const absentId = safeId(Number(sql('SELECT COALESCE(MAX(id),0) FROM copage_group;').trim()) + 100000)
  assert.equal(sql(`SELECT COUNT(*) FROM copage_group WHERE id=${absentId};`).trim(), '0')
  await brokenReceipt({ groupId: absentId, expected: 404 })
  await brokenReceipt({ credentials: viewer, userId: viewerProfile.id, groupId: own.result.id, expected: 403 })

  // 仅暂时移除本fixture自己创建的owner行，并逐字保留joined_at；绝不由重放自动修复。
  const beforeMissingOwner = snapshot(sql), ownerId = own.userId, groupId = own.result.id
  assert.equal(sql(`SELECT COUNT(*) FROM copage_group WHERE id=${groupId} AND owner_id=${ownerId} AND HEX(name)='${hex(own.body.name + '-已改名')}' AND is_archived=0;`).trim(), '1')
  assert.equal(sql(`SELECT COUNT(*) FROM group_creation_receipt WHERE user_id=${ownerId} AND request_id='${own.key}' AND group_id=${groupId};`).trim(), '1')
  assert.equal(sql(`SELECT COUNT(*) FROM group_member WHERE group_id=${groupId};`).trim(), '1', '仅允许修改本轮只含owner的随机合成小组')
  assert.equal(sql(`SELECT COUNT(*) FROM group_invitation WHERE group_id=${groupId}; SELECT COUNT(*) FROM copage_project WHERE group_id=${groupId};`).trim(), '0\n0')
  const joinedHex = sql(`SELECT HEX(CAST(joined_at AS CHAR)) FROM group_member WHERE group_id=${groupId} AND user_id=${ownerId} AND role='owner';`).trim()
  assert.match(joinedHex, /^[0-9A-F]+$/)
  assert.equal(sql(`DELETE FROM group_member WHERE group_id=${groupId} AND user_id=${ownerId} AND role='owner'; SELECT ROW_COUNT();`).trim(), '1')
  try {
    const missingOwner = snapshot(sql)
    await api(owner, '/groups', 'POST', own.body, 403, own.key, peerPort)
    assert.equal(snapshot(sql), missingOwner, 'owner成员缺失须拒绝，不插入替代成员或改原回执')
  } finally {
    assert.equal(sql(`SELECT COUNT(*) FROM group_member WHERE group_id=${groupId} AND user_id=${ownerId};`).trim(), '0', '错误重放若新增成员，不得用恢复操作覆盖证据')
    assert.equal(sql(`INSERT INTO group_member(group_id,user_id,role,joined_at)
      SELECT ${groupId},${ownerId},'owner',CONVERT(UNHEX('${joinedHex}') USING utf8mb4)
      WHERE EXISTS(SELECT 1 FROM copage_group WHERE id=${groupId} AND owner_id=${ownerId} AND HEX(name)='${hex(own.body.name + '-已改名')}')
      AND NOT EXISTS(SELECT 1 FROM group_member WHERE group_id=${groupId} AND user_id=${ownerId}); SELECT ROW_COUNT();`).trim(), '1')
    assert.equal(sql(`SELECT HEX(CAST(joined_at AS CHAR)) FROM group_member WHERE group_id=${groupId} AND user_id=${ownerId} AND role='owner';`).trim(), joinedHex)
  }
  assert.equal(snapshot(sql), beforeMissingOwner, '合成owner成员恢复后完整资料及时间必须不变')
  await replay(own)
  for (const entry of requests) {
    entry.state = sql(originalGroupSql(entry.result.id)).trim()
    entry.current = currentCreationView(sql, entry)
  }
  assert.deepEqual(await api(viewer, '/groups/invitations'), inboxBefore, '本轮不应新增或改变未接受邀请')
  assert.equal(sql(unrelatedSql).trim(), unrelatedBefore, '小组创建不得改变文档或项目创建回执')
  assert.equal(sql('SELECT COUNT(*) FROM group_creation_receipt WHERE group_id<=0;').trim(), '0', '临时坏回执必须全部清理')
  console.log('PASS: 小组双后端八并发唯一组/owner/回执、UUID账号隔离、原资料冲突/失败回滚、改名归档原号及坏回执/成员缺失拒绝')
  return { requests }
}

export async function verifyGroupCreationRecovery({ port, fixture, sql }) {
  assert.equal(typeof sql, 'function')
  const api = client(port), before = snapshot(sql)
  for (const entry of fixture.requests) {
    assert.deepEqual(currentCreationView(sql, entry), entry.current, '恢复须先保留当前名称、归档及真实owner')
    assert.deepEqual(await api(entry.credentials, '/groups', 'POST', entry.body, 200, entry.key),
      entry.current, '新卷恢复后同UUID须返回原小组、当前名称及归档状态')
    assert.equal(sql(originalGroupSql(entry.result.id)).trim(), entry.state, '恢复必须保留改名、归档、owner成员及全部时间字段')
    assert.equal(sql(receiptSql(entry.userId, entry.key)).trim(), entry.receipt, '恢复须逐字段保留原创建回执含时间')
    assert.equal(sql(`SELECT COUNT(*) FROM group_member WHERE group_id=${entry.result.id} AND user_id=${entry.userId} AND role='owner';`).trim(), '1')
  }
  assert.equal(snapshot(sql), before, '恢复后原UUID确认不得增组、增成员或改变任何小组创建回执')
  console.log('PASS: 新卷SQL恢复后小组原UUID唯一确认，当前资料/归档/owner关系及完整回执保持')
}
