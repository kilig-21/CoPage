import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'

// 固定当前18表的完整列合同；密码列只比较其字节摘要，不输出密码或令牌。
const tables = [
  ['user', 'id,HEX(username),SHA2(HEX(password),256),credential_version,HEX(nickname),HEX(avatar),create_time', 'id'],
  ['document', 'id,HEX(title),HEX(content),revision,owner_id,parent_id,is_deleted,create_time,update_time', 'id'],
  ['doc_operation', 'id,doc_id,revision,HEX(op),user_id,create_time', 'id'],
  ['doc_operation_receipt', 'doc_id,user_id,HEX(client_id),HEX(op_id),revision,request_hash', 'doc_id,user_id,client_id,op_id'],
  ['doc_snapshot', 'id,doc_id,revision,HEX(content),create_time', 'id'],
  ['doc_collaborator', 'id,doc_id,user_id,permission,create_time', 'id'],
  ['doc_history_boundary', 'doc_id,revision,update_time', 'doc_id'],
  ['doc_named_version', 'doc_id,revision,HEX(name),HEX(content),user_id,create_time', 'doc_id,revision'],
  ['copage_group', 'id,HEX(name),HEX(description),owner_id,is_archived,create_time,update_time', 'id'],
  ['group_member', 'group_id,user_id,role,joined_at', 'group_id,user_id'],
  ['group_invitation', 'group_id,user_id,inviter_id,status,invitation_version,create_time,update_time', 'group_id,user_id'],
  ['copage_project', 'id,HEX(name),HEX(description),owner_id,group_id,is_archived,create_time,update_time', 'id'],
  ['project_document', 'project_id,doc_id,association_id,added_by,create_time', 'project_id,doc_id'],
  ['personal_template_owner', 'user_id', 'user_id'],
  ['personal_template', 'id,owner_id,HEX(name),HEX(description),category,HEX(content),content_bytes,source_revision,version,create_time,update_time', 'id'],
  ['doc_creation_receipt', 'user_id,request_id,kind,request_hash,doc_id,HEX(response_json),create_time', 'user_id,request_id'],
  ['project_creation_receipt', 'user_id,request_id,request_hash,project_id,group_id,create_time', 'user_id,request_id'],
  ['group_creation_receipt', 'user_id,request_id,request_hash,group_id,create_time', 'user_id,request_id'],
]
export const projectDocumentCreationSnapshotSql = tables.map(([table, columns, order]) =>
  `SELECT '${table}',COUNT(*) FROM \`${table}\`; SELECT ${columns} FROM \`${table}\` ORDER BY ${order};`).join('\n')
const hex = value => Buffer.from(value).toString('hex').toUpperCase()
const safeId = value => { assert.ok(Number.isSafeInteger(value) && value > 0); return value }
const snapshot = sql => sql(projectDocumentCreationSnapshotSql).trim()
function client(port) {
  const tokens = new Map()
  return async (credentials, path, method = 'GET', body, expected = 200, key, target = port) => {
    if (!tokens.has(credentials.username)) {
      const login = await fetch(`http://127.0.0.1:${target}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials), signal: AbortSignal.timeout(15000),
      })
      assert.equal(login.status, 200, '隔离项目文档创建账号登录失败')
      const payload = await login.json(); assert.equal(payload.code, 0)
      tokens.set(credentials.username, payload.data.token)
    }
    const response = await fetch(`http://127.0.0.1:${target}/api${path}`, {
      method, signal: AbortSignal.timeout(30000),
      headers: { Authorization: 'Bearer ' + tokens.get(credentials.username),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(key !== undefined ? { 'Idempotency-Key': key } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    assert.equal(response.status, expected, `${method} ${path} HTTP状态不符`)
    const payload = await response.json()
    if (expected === 200) assert.equal(payload.code, 0, `${method} ${path}业务拒绝`)
    else assert.notEqual(payload.code, 0, '拒绝响应不得报告创建成功')
    return payload.data
  }
}

export async function createProjectDocumentCreationFixture({ port, peerPort, owner, viewer, outsider, sql, rootSql, projectName }) {
  assert.match(projectName ?? '', /^copage-prod-qa-[0-9a-f]{12}$/, '仅允许已核对的随机隔离生产项目')
  assert.ok(Number.isInteger(port) && Number.isInteger(peerPort) && port !== peerPort)
  assert.equal(typeof sql, 'function'); assert.equal(typeof rootSql, 'function')
  const api = client(port), marker = '项目内新建-' + randomBytes(8).toString('hex'), requests = [], rejected = []
  const ownerId = safeId((await api(owner, '/account/me')).id), viewerId = safeId((await api(viewer, '/account/me')).id)
  const outsiderId = safeId((await api(outsider, '/account/me')).id)
  assert.equal(new Set([ownerId, viewerId, outsiderId]).size, 3)
  const inboxBefore = await api(viewer, '/groups/invitations')
  const personal = await api(owner, '/projects', 'POST', { name: marker + '-个人一', groupId: 0 })
  const second = await api(owner, '/projects', 'POST', { name: marker + '-个人二', groupId: 0 })
  const group = await api(owner, '/groups', 'POST', { name: marker + '-小组', description: '逐篇文档授权' })
  const grouped = await api(owner, '/projects', 'POST', { name: marker + '-小组项目', groupId: group.id })
  for (const row of [personal, second, group, grouped]) safeId(row.id)
  const path = project => `/projects/${project}/documents/new`
  const join = async credentials => {
    await api(owner, `/groups/${group.id}/invitations`, 'POST', { username: credentials.username })
    const invitation = (await api(credentials, '/groups/invitations')).list.find(row => row.groupId === group.id)
    assert.ok(invitation)
    await api(credentials, `/groups/${group.id}/invitation`, 'POST', { accept: true, invitationVersion: invitation.invitationVersion })
  }
  const remember = async (credentials, userId, projectId, body, key = randomUUID()) => {
    const count = Number(sql('SELECT COUNT(*) FROM document;').trim())
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => api(credentials, path(projectId), 'POST', body, 200,
      index % 2 ? key.toUpperCase() : key, index % 2 ? peerPort : port)))
    const result = results[0]
    safeId(result.id); assert.equal(result.projectId, projectId); assert.equal(result.title, body.title)
    assert.deepEqual(Object.keys(result).sort(), ['id', 'projectId', 'title'])
    for (const value of results) assert.deepEqual(value, result, '双实例原UUID只能返回首次创建结果')
    assert.equal(Number(sql('SELECT COUNT(*) FROM document;').trim()), count + 1, '八并发只能新增一篇正文')
    const document = await api(credentials, '/doc/' + result.id)
    assert.equal(document.ownerId, userId); assert.equal(document.revision, 0); assert.equal(document.title, body.title)
    assert.deepEqual(await api(credentials, `/doc/${result.id}/collaborators`), [])
    const initial = sql(`SELECT revision,HEX(content) FROM doc_snapshot WHERE doc_id=${result.id} ORDER BY id;`).trim()
    const content = sql(`SELECT HEX(content) FROM document WHERE id=${result.id};`).trim()
    assert.equal(initial, body.templateId ? '0\t' + content : '', '模板首次快照须与正文同事务保存')
    assert.equal(sql(`SELECT COUNT(*) FROM doc_operation WHERE doc_id=${result.id}; SELECT COUNT(*) FROM doc_operation_receipt WHERE doc_id=${result.id};`).trim(), '0\n0')
    const association = sql(`SELECT project_id,doc_id,association_id,added_by,create_time FROM project_document WHERE doc_id=${result.id};`).trim().split('\t')
    assert.equal(association.length, 5); assert.equal(Number(association[0]), projectId); assert.equal(Number(association[1]), result.id)
    assert.match(association[2], /^[0-9a-f-]{36}$/); assert.equal(Number(association[3]), userId)
    assert.ok(association[4])
    assert.equal(sql(`SELECT COUNT(*) FROM doc_creation_receipt WHERE user_id=${userId} AND request_id='${key}' AND kind='project-document:${projectId}' AND doc_id=${result.id};`).trim(), '1')
    assert.equal(sql(`SELECT COUNT(*) FROM doc_creation_receipt WHERE doc_id=${result.id};`).trim(), '1')
    const receipt = JSON.parse(Buffer.from(sql(`SELECT HEX(response_json) FROM doc_creation_receipt WHERE user_id=${userId} AND request_id='${key}';`).trim(), 'hex').toString())
    assert.deepEqual(receipt, result)
    const entry = { credentials, userId, projectId, body, key, result, associationId: association[2] }
    requests.push(entry)
    return entry
  }
  const replay = async entry => {
    const before = snapshot(sql)
    assert.deepEqual(await api(entry.credentials, path(entry.projectId), 'POST', entry.body, 200, entry.key, peerPort), entry.result)
    assert.equal(snapshot(sql), before, '原UUID确认不得更新18表任何字段或时间、补建或重新关联')
  }
  const reject = async (credentials, projectId, body, expected, key = randomUUID(), rememberFailure = true) => {
    const before = snapshot(sql)
    await api(credentials, path(projectId), 'POST', body, expected, key)
    assert.equal(snapshot(sql), before, '失败必须整体回滚正文、初始快照、关联和占位回执')
    if (rememberFailure) rejected.push({ credentials, projectId, body, expected, key })
  }
  const sameBody = { title: marker + '-相同输入', templateId: null }
  const first = await remember(owner, ownerId, personal.id, sameBody)
  const other = await remember(owner, ownerId, second.id, sameBody)
  assert.notEqual(first.result.id, other.result.id)
  await reject(owner, second.id, sameBody, 400, first.key, false)
  await reject(owner, personal.id, { ...sameBody, title: ' ' + sameBody.title }, 400, first.key, false)
  await reject(owner, personal.id, { ...sameBody, templateId: 'notes' }, 400, first.key, false)
  await reject(viewer, personal.id, { title: marker + '-无个人项目权', templateId: null }, 403)
  await reject(outsider, grouped.id, { title: marker + '-未加入小组', templateId: null }, 403, randomUUID(), false)
  await join(viewer); await join(outsider)
  assert.equal(sql(`SELECT role FROM group_member WHERE group_id=${group.id} AND user_id=${viewerId};`).trim(), 'member')
  const member = await remember(viewer, viewerId, grouped.id, { title: marker + '-成员模板', templateId: 'notes' })
  for (const credentials of [owner, outsider]) {
    await api(credentials, '/doc/' + member.result.id, 'GET', undefined, 403)
    const detail = await api(credentials, '/projects/' + grouped.id)
    assert.equal(detail.total, 0); assert.deepEqual(detail.list, [], '小组或项目权限不能泄露未授权文档标题')
  }
  assert.equal((await api(viewer, '/projects/' + grouped.id)).canManage, false)
  await api(owner, `/projects/${personal.id}/archive`, 'POST', {})
  await reject(owner, personal.id, { title: marker + '-归档个人项目', templateId: 'notes' }, 404, randomUUID(), false)
  await replay(first)
  await api(owner, `/projects/${personal.id}/restore`, 'POST', {})
  await api(owner, `/groups/${group.id}/archive`, 'POST', {})
  await reject(viewer, grouped.id, { title: marker + '-归档小组', templateId: 'notes' }, 404, randomUUID(), false)
  await replay(member)
  await api(owner, `/groups/${group.id}/restore`, 'POST', {})
  await api(owner, `/projects/${grouped.id}/archive`, 'POST', {})
  await reject(viewer, grouped.id, { title: marker + '-归档组项目', templateId: null }, 404, randomUUID(), false)
  await replay(member)
  await api(owner, `/projects/${grouped.id}/restore`, 'POST', {})

  // 真实关联写入故障；仅本轮精确项目+操作者触发，不用非法模板伪装后置事务回滚。
  const trigger = 'qa_project_doc_' + randomBytes(8).toString('hex'), signal = 'atomic_' + randomBytes(12).toString('hex')
  const triggerBody = `BEGIN IF NEW.project_id=${second.id} AND NEW.added_by=${ownerId} THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='${signal}'; END IF; END`
  assert.equal(rootSql(`SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA='collab_doc' AND TRIGGER_NAME='${trigger}';`).trim(), '0')
  assert.equal(sql(`SELECT COUNT(*) FROM copage_project WHERE id=${second.id} AND owner_id=${ownerId} AND group_id=0 AND HEX(name)='${hex(marker + '-个人二')}';`).trim(), '1')
  assert.equal(rootSql('SELECT @@performance_schema;').trim(), '1', '真实触发证明需要Performance Schema')
  assert.equal(rootSql(`SELECT COUNT(*) FROM performance_schema.setup_consumers WHERE NAME IN
    ('global_instrumentation','thread_instrumentation','events_statements_current') AND ENABLED='YES';`).trim(), '3', '触发统计的全局/线程/当前语句采集必须开启')
  assert.equal(rootSql("SELECT COUNT(*) FROM performance_schema.setup_instruments WHERE NAME='statement/sp/stmt' AND ENABLED='YES';").trim(), '1', '存储程序语句instrument必须开启')
  const objectGuard = `OBJECT_TYPE='TRIGGER' AND OBJECT_SCHEMA='collab_doc' AND OBJECT_NAME='${trigger}'`
  assert.equal(rootSql(`SELECT COUNT(*) FROM performance_schema.setup_objects WHERE ${objectGuard};`).trim(), '0')
  // 只显式开启本轮随机触发器，不修改其他存储程序、消费者或全局instrument配置。
  rootSql(`INSERT INTO performance_schema.setup_objects(OBJECT_TYPE,OBJECT_SCHEMA,OBJECT_NAME,ENABLED,TIMED)
    VALUES('TRIGGER','collab_doc','${trigger}','YES','YES');`)
  const failedKey = randomUUID(), failedBody = { title: marker + '-后置关联回滚', templateId: 'notes' }
  try {
    // rootSql使用mysql客户端stdin，BEGIN内分号须通过客户端DELIMITER完整送到服务器。
    rootSql(`DELIMITER $$\nCREATE TRIGGER \`${trigger}\` BEFORE INSERT ON project_document FOR EACH ROW ${triggerBody}$$\nDELIMITER ;\n`)
    await reject(owner, second.id, failedBody, 500, failedKey, false)
    const counters = rootSql(`SELECT COALESCE(SUM(COUNT_STAR),0),COALESCE(SUM(SUM_ERRORS),0) FROM performance_schema.events_statements_summary_by_program
      WHERE OBJECT_TYPE='TRIGGER' AND OBJECT_SCHEMA='collab_doc' AND OBJECT_NAME='${trigger}';`).trim().split('\t').map(Number)
    assert.ok(counters[0] >= 1 && counters[1] >= 1, '必须观测到本轮精确触发器真实执行及抛错，不能只凭HTTP500推断')
    console.log('PASS: 精确关联触发器真实执行并抛错，正文/模板快照/关联/回执全部回滚（不比较自增编号间隙）')
  } finally {
    try {
      const definition = rootSql(`SELECT HEX(ACTION_STATEMENT) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA='collab_doc' AND TRIGGER_NAME='${trigger}' AND EVENT_OBJECT_TABLE='project_document';`).trim()
      if (definition) {
        assert.equal(definition, hex(triggerBody), '清理前核对本轮触发器完整定义')
        rootSql(`DROP TRIGGER \`${trigger}\`;`)
      }
    } finally {
      assert.equal(rootSql(`SELECT ENABLED,TIMED FROM performance_schema.setup_objects WHERE ${objectGuard};`).trim(), 'YES\tYES', '仅清理本轮加入且未变化的精确instrument规则')
      rootSql(`DELETE FROM performance_schema.setup_objects WHERE ${objectGuard} AND ENABLED='YES' AND TIMED='YES';`)
    }
  }
  await remember(owner, ownerId, second.id, failedBody, failedKey)
  await api(viewer, '/doc/' + member.result.id, 'PUT', { title: member.body.title + '-已改名' })
  await replay(member)
  await api(viewer, `/projects/${grouped.id}/documents/${member.result.id}?associationId=${member.associationId}`, 'DELETE')
  await replay(member)
  assert.equal(sql(`SELECT COUNT(*) FROM project_document WHERE doc_id=${member.result.id};`).trim(), '0')
  await api(viewer, '/doc/' + member.result.id, 'DELETE')
  await replay(member)
  assert.equal(sql(`SELECT is_deleted FROM document WHERE id=${member.result.id};`).trim(), '1')
  await api(viewer, `/groups/${group.id}/leave`, 'POST', {})
  await api(viewer, '/projects/' + grouped.id, 'GET', undefined, 403)
  await replay(member)
  await reject(viewer, grouped.id, { title: marker + '-退组新请求', templateId: 'notes' }, 403)
  await api(owner, `/projects/${grouped.id}/archive`, 'POST', {})
  await replay(member)
  await reject(owner, grouped.id, { title: marker + '-归档新请求', templateId: 'notes' }, 404)
  assert.equal(sql(`SELECT is_archived FROM copage_group WHERE id=${group.id};`).trim(), '0')
  assert.deepEqual(await api(viewer, '/groups/invitations'), inboxBefore, '不留下新增未接受邀请')
  console.log('PASS: 项目内个人/普通成员创建、双实例八并发单篇/关联/回执、项目隔离、逐篇授权、当前权限拒绝及后续移出/删除/退组原请求不补建')
  return { requests, rejected, state: snapshot(sql) }
}

export async function verifyProjectDocumentCreationRecovery({ port, fixture, sql }) {
  const api = client(port)
  assert.equal(snapshot(sql), fixture.state, '新卷须先逐字段恢复18表，含正文/状态/所有快照/关联UUID/回执JSON及全部时间')
  for (const entry of fixture.requests) {
    assert.deepEqual(await api(entry.credentials, `/projects/${entry.projectId}/documents/new`, 'POST', entry.body, 200, entry.key), entry.result)
    assert.equal(snapshot(sql), fixture.state, '恢复后确认原创建不得改变任何表字段、补建或重新关联')
  }
  for (const entry of fixture.rejected) {
    await api(entry.credentials, `/projects/${entry.projectId}/documents/new`, 'POST', entry.body, entry.expected, entry.key)
    assert.equal(snapshot(sql), fixture.state, '无原回执的失败请求恢复后仍按当前权限拒绝且无残留')
  }
  console.log('PASS: 18表全字段新卷恢复，原项目文档回执/关联UUID/时间完整；改名/移出/软删除/退组后原UUID仍只确认原结果')
}
