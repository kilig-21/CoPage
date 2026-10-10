import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'

// 调用方提供隔离账号/端口；凭据只在内存，验证失败不打印请求体或令牌。
function client(port) {
  const tokens = new Map()
  return async (credentials, path, method = 'GET', body, expected = 200, key, target = port) => {
    let token = tokens.get(credentials.username)
    if (!token) {
      const login = await fetch(`http://127.0.0.1:${target}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(credentials), signal: AbortSignal.timeout(15000),
      })
      assert.equal(login.status, 200, '创建验收账号登录失败')
      const response = await login.json(); assert.equal(response.code, 0)
      token = response.data.token; tokens.set(credentials.username, token)
    }
    const multipart = body instanceof FormData
    const response = await fetch(`http://127.0.0.1:${target}/api${path}`, {
      method, signal: AbortSignal.timeout(15000),
      headers: { Authorization: 'Bearer ' + token, ...(body && !multipart ? { 'Content-Type': 'application/json' } : {}),
        ...(key ? { 'Idempotency-Key': key } : {}) },
      body: body ? multipart ? body : JSON.stringify(body) : undefined,
    })
    assert.equal(response.status, expected, `${method} ${path} HTTP状态不符`)
    const payload = await response.json()
    if (expected === 200) assert.equal(payload.code, 0, `${method} ${path}业务拒绝`)
    return payload.data
  }
}
function importBody(title) {
  const body = new FormData()
  body.append('file', new File(['创建重试中文😀\n第二行\n'], '创建验收.txt', { type: 'text/plain' }))
  body.append('title', title)
  return body
}
export const creationSnapshotSql = 'SELECT user_id,request_id,kind,request_hash,doc_id,HEX(response_json),create_time FROM doc_creation_receipt ORDER BY user_id,request_id;'

export async function createCreationFixture({ port, peerPort = port, owner, viewer, sql }) {
  const api = client(port), marker = '创建验收-' + randomBytes(6).toString('hex'), requests = []
  const ownerProfile = await api(owner, '/account/me'), viewerProfile = await api(viewer, '/account/me')
  const remember = async (credentials, path, body, { concurrent = false, multipart = false, key = randomUUID() } = {}) => {
    const response = concurrent ? await Promise.all(Array.from({ length: 8 }, (_, index) =>
      api(credentials, path, 'POST', body, 200, key, index % 2 ? peerPort : port))) : [await api(credentials, path, 'POST', body, 200, key)]
    for (const value of response) assert.deepEqual(value, response[0], '并发重试必须返回同一首次摘要')
    const result = response[0], document = await api(credentials, '/doc/' + result.id)
    assert.equal(document.revision, 0)
    assert.deepEqual(await api(credentials, '/doc/' + result.id + '/collaborators'), [])
    assert.deepEqual((await api(credentials, '/doc/' + result.id + '/history/0')).content, document.content)
    requests.push({ credentials, path, body: multipart ? { title: body.get('title') } : body, multipart, key, result, document })
    assert.deepEqual(await api(credentials, path, 'POST', body, 200, key, peerPort), result)
    return document
  }
  const blank = await remember(owner, '/doc', { title: marker + '-空白' }, { concurrent: true })
  assert.equal(blank.ownerId, ownerProfile.id)
  const source = await remember(owner, '/doc', { title: marker + '-框架', templateId: 'notes' })
  await remember(owner, '/doc/import', importBody(marker + '-导入'), { multipart: true, concurrent: true })
  const copy = await remember(owner, '/doc/' + source.id + '/copy', { title: marker + '-副本' }, { concurrent: true })
  assert.deepEqual(copy.content, source.content)
  await api(viewer, '/doc/' + source.id + '/copy', 'POST', {}, 403, randomUUID())
  await api(owner, '/doc/' + source.id + '/collaborators', 'POST', { username: viewer.username, permission: 1 })
  const sharedKey = randomUUID()
  const ownerCopy = await remember(owner, '/doc/' + source.id + '/copy', {}, { key: sharedKey })
  const viewerCopy = await remember(viewer, '/doc/' + source.id + '/copy', {}, { key: sharedKey, concurrent: true })
  assert.notEqual(ownerCopy.id, viewerCopy.id); assert.equal(viewerCopy.ownerId, viewerProfile.id)
  assert.deepEqual(viewerCopy.content, source.content)
  await api(owner, '/doc/' + viewerCopy.id, 'GET', undefined, 403)
  await api(viewer, '/doc/' + ownerCopy.id, 'GET', undefined, 403)
  await api(owner, '/doc/' + source.id + '/collaborators/' + viewerProfile.id, 'DELETE')
  const ownTemplate = await api(owner, '/personal-templates', 'POST', { docId: source.id, name: marker, category: 'planning' })
  const template = await api(owner, '/personal-templates/' + ownTemplate.id)
  const instance = await remember(owner, '/personal-templates/' + template.id + '/documents',
    { title: marker + '-私人实例', expectedVersion: template.version }, { concurrent: true })
  assert.deepEqual(instance.content, source.content)
  await api(owner, '/personal-templates/' + template.id + '?expectedVersion=' + template.version, 'DELETE')
  // 收据仍可确认既有私人实例，不能因模板删除再次创建；撤权来源亦然。
  const replay = requests.at(-1)
  assert.deepEqual(await api(owner, replay.path, 'POST', replay.body, 200, replay.key), replay.result)
  for (const entry of requests) {
    const changed = entry.multipart ? importBody(marker + '-不同') : { ...entry.body, title: marker + '-不同' }
    await api(entry.credentials, entry.path, 'POST', changed, 400, entry.key)
  }
  await api(owner, '/doc/' + source.id + '/copy', 'POST', {}, 400, requests[0].key)
  await api(owner, '/doc', 'POST', { title: marker }, 400, 'invalid-key')
  const originalCount = (await api(owner, '/doc/list?scope=owned&size=100')).total
  await api(owner, '/doc/' + blank.id, 'DELETE')
  await api(owner, '/doc/' + blank.id, 'GET', undefined, 404)
  assert.deepEqual(await api(owner, requests[0].path, 'POST', requests[0].body, 200, requests[0].key), requests[0].result)
  assert.equal((await api(owner, '/doc/list?scope=owned&size=100')).total, originalCount - 1, '删除目标后的旧重试不能创建替代文档')
  await api(owner, '/doc/' + blank.id + '/restore', 'POST', {})
  assert.deepEqual((await api(owner, '/doc/' + blank.id)).content, blank.content)
  if (sql) {
    const failedKey = randomUUID(), before = sql('SELECT COUNT(*) FROM document;').trim()
    await api(owner, '/doc', 'POST', { title: marker, templateId: 'unknown-template' }, 400, failedKey)
    assert.equal(sql('SELECT COUNT(*) FROM document;').trim(), before, '创建失败不得留下文档')
    assert.equal(sql(`SELECT COUNT(*) FROM doc_creation_receipt WHERE user_id=${ownerProfile.id} AND request_id='${failedKey}';`).trim(), '0', '创建失败须回滚占位收据')
    for (const entry of requests) {
      const id = entry.result.id
      assert.equal(sql(`SELECT COUNT(*) FROM doc_creation_receipt WHERE doc_id=${id};`).trim(), '1')
      const titleBytes = Buffer.from(entry.document.title, 'utf8').toString('hex').toUpperCase()
      assert.equal(sql(`SELECT COUNT(*) FROM document WHERE owner_id=${entry.document.ownerId} AND HEX(title)='${titleBytes}' AND is_deleted=0;`).trim(), '1', '并发请求不能留下额外同名文档')
      assert.equal(sql(`SELECT COUNT(*) FROM doc_operation WHERE doc_id=${id}; SELECT COUNT(*) FROM doc_operation_receipt WHERE doc_id=${id};`).trim(), '0\n0')
    }
  }
  console.log('PASS: 四类创建持久收据、跨实例并发单篇/版本0、请求冲突、账号隔离、只读副本、删除目标不替代及失败事务回滚')
  return { requests, owner, viewer, marker }
}

export async function verifyCreationRecovery({ port, fixture }) {
  const api = client(port)
  for (const entry of fixture.requests) {
    const before = (await api(entry.credentials, '/doc/list?scope=owned&size=100')).total
    const body = entry.multipart ? importBody(entry.body.title) : entry.body
    assert.deepEqual(await api(entry.credentials, entry.path, 'POST', body, 200, entry.key), entry.result)
    const document = await api(entry.credentials, '/doc/' + entry.result.id)
    assert.deepEqual(document.content, entry.document.content)
    assert.equal(document.revision, 0); assert.equal(document.ownerId, entry.document.ownerId)
    assert.equal((await api(entry.credentials, '/doc/list?scope=owned&size=100')).total, before)
  }
  console.log('PASS: SQL/新卷恢复后所有创建标识返回原文档，删除模板和撤权来源不导致重复创建')
}
