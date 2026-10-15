import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'

const emptyContent = '{"ops":[{"insert":"\\n"}]}'
const emptyHash = createHash('sha256').update(emptyContent).digest('hex')
const hex = text => Buffer.from(text).toString('hex').toUpperCase()
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const safeId = id => { assert.ok(Number.isSafeInteger(id) && id > 0); return id }

// 独立 mysql 客户端保持交互事务；每一步由输出标记确认，不靠延时猜测锁已取得。
function holdDocument({ mysqlId, id, cwd, env }) {
  const marker = 'renamebarrier' + randomBytes(12).toString('hex')
  const child = spawn('docker', ['exec', '-i', mysqlId, 'sh', '-ec',
    'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql --default-character-set=utf8mb4 -uroot --batch --raw --skip-column-names --unbuffered -D collab_doc'],
  { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  let output = '', ended = false, failure, connectionId
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', text => { output += text; if (output.length > 65536) failure = Error('隔离锁会话输出超限') })
  child.stderr.on('data', () => {}) // 不输出环境或登录资料。
  child.on('error', () => { failure = Error('隔离锁会话未能启动') })
  child.on('close', code => { ended = true; if (code !== 0) failure = Error('隔离锁会话异常结束') })
  child.stdin.on('error', () => { failure = Error('隔离锁会话输入已关闭') })
  const waitFor = async condition => {
    const deadline = Date.now() + 30000
    while (!(typeof condition === 'function' ? condition() : output.includes(condition))) {
      if (failure) throw failure
      assert.ok(!ended, '锁会话提前结束')
      assert.ok(Date.now() < deadline, '锁会话标记等待超过30秒')
      await pause(25)
    }
  }
  let released = false
  return {
    async lock() {
      child.stdin.write(`START TRANSACTION; SELECT id FROM document WHERE id=${id} FOR UPDATE; SELECT '${marker}',CONNECTION_ID();\n`)
      await waitFor(() => new RegExp(marker + '\\t\\d+\\r?\\n').test(output))
      connectionId = safeId(Number(output.split(marker + '\t')[1].split(/\r?\n/)[0]))
      return connectionId
    },
    async release(commit) {
      if (!released && !ended && !failure) {
        child.stdin.write(`${commit ? 'COMMIT' : 'ROLLBACK'}; SELECT '${marker}released';\n`)
        try { await waitFor(marker + 'released'); released = true }
        finally { child.stdin.end() }
      } else if (!ended) child.stdin.end()
      const deadline = Date.now() + 10000
      while (!ended && Date.now() < deadline) await pause(25)
      if (!ended) { child.kill(); throw Error('隔离锁会话退出超时；由外层随机栈清理终止') }
      if (!released && failure) throw failure
    },
  }
}

export async function runDocumentRenamePermissionCheck({ docker, source, sql, ports, username, password, cwd, env = process.env }) {
  const config = JSON.parse(source(['config', '--format', 'json']).stdout)
  assert.match(config.name, /^copage-prod-qa-[0-9a-f]{12}$/, '权限竞态只能用于本轮随机隔离生产项目')
  assert.equal(ports.length, 2); assert.notEqual(ports[0], ports[1])
  for (const port of ports) assert.ok(Number.isSafeInteger(port) && port > 0 && port <= 65535)
  for (let index = 0; index < ports.length; index++) {
    assert.equal(source(['port', '--index', String(index + 1), 'backend', '8080']).stdout.trim(), `127.0.0.1:${ports[index]}`,
      'API端口必须属于本次已核对的隔离后端，禁止指向8080等原有服务')
  }
  const mysqlId = source(['ps', '-q', 'mysql']).stdout.trim()
  assert.match(mysqlId, /^[0-9a-f]{12,64}$/)
  const ids = source(['ps', '-q', 'backend']).stdout.trim().split(/\s+/)
  assert.equal(ids.length, 2, '需要两个真实后端容器')
  for (const id of [mysqlId, ...ids]) {
    assert.match(id, /^[0-9a-f]{12,64}$/)
    assert.equal(docker(['inspect', '--format', '{{index .Config.Labels "com.docker.compose.project"}}', id]).stdout.trim(), config.name)
  }
  const query = statement => {
    const result = sql(statement, true)
    assert.equal(result.status, 0, '隔离库 root 核对失败')
    return result.stdout.trim()
  }
  const api = async (port, token, path, method = 'GET', body, signal) => {
    const response = await fetch(`http://127.0.0.1:${port}/api${path}`, {
      method, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000),
      headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: response.status, payload: await response.json() }
  }
  const success = async promise => {
    const result = await promise
    assert.equal(result.status, 200); assert.equal(result.payload.code, 0)
    return result.payload.data
  }
  const owner = await success(api(ports[0], null, '/auth/login', 'POST', { username, password }))
  const ownerId = safeId((await success(api(ports[0], owner.token, '/account/me'))).id)
  const nonce = randomBytes(12).toString('hex')
  const credentials = { username: 'rename' + nonce, password: randomBytes(32).toString('hex') }
  await success(api(ports[0], null, '/auth/register', 'POST', credentials))
  const viewer = await success(api(ports[1], null, '/auth/login', 'POST', credentials))
  const viewerId = safeId((await success(api(ports[1], viewer.token, '/account/me'))).id)
  assert.notEqual(ownerId, viewerId)
  const failures = []
  const readDocument = id => {
    const values = query(`SELECT id,HEX(title),SHA2(content,256),revision,owner_id,parent_id,is_deleted FROM document WHERE id=${id};`).split('\t')
    assert.equal(values.length, 7)
    return { id: Number(values[0]), title: Buffer.from(values[1], 'hex').toString('utf8'), hash: values[2],
      revision: Number(values[3]), ownerId: Number(values[4]), parentId: Number(values[5]), deleted: Number(values[6]) }
  }
  const assertEmpty = (id, titles, deleted = 0) => {
    const row = readDocument(id)
    assert.equal(row.id, id); assert.equal(row.ownerId, ownerId); assert.equal(row.parentId, 0); assert.equal(row.deleted, deleted)
    assert.ok(titles.includes(row.title), '精确合成标题守卫不符')
    assert.equal(row.hash, emptyHash); assert.equal(row.revision, 0)
    assert.equal(query(`SELECT HEX(content) FROM document WHERE id=${id};`), hex(emptyContent))
    const tables = ['doc_operation', 'doc_operation_receipt', 'doc_snapshot', 'doc_named_version', 'doc_history_boundary', 'project_document', 'doc_creation_receipt']
    assert.equal(query(tables.map(table => `SELECT COUNT(*) FROM ${table} WHERE doc_id=${id};`).join('\n')), tables.map(() => '0').join('\n'))
    assert.equal(query(`SELECT COUNT(*) FROM document WHERE parent_id=${id};`), '0')
    return row
  }
  const members = id => query(`SELECT user_id,permission FROM doc_collaborator WHERE doc_id=${id} ORDER BY user_id;`)
  const renameAllowed = async (port, token, id, title, expectedMembers) => {
    const result = await success(api(port, token, `/doc/${id}`, 'PUT', { title }))
    assert.equal(result.id, id); assert.equal(result.title, title)
    assert.equal(typeof result.updateTime, 'string')
    assertEmpty(id, [title])
    const metadata = await success(api(port, token, `/doc/${id}/metadata`))
    assert.equal(metadata.id, id); assert.equal(metadata.title, title)
    assert.equal(metadata.updateTime, result.updateTime)
    const detail = await success(api(ports[0], owner.token, `/doc/${id}`))
    assert.equal(detail.id, id); assert.equal(detail.title, title); assert.equal(detail.revision, 0)
    assert.deepEqual(detail.content, JSON.parse(emptyContent)); assert.equal(detail.ownerId, ownerId)
    assert.equal(members(id), expectedMembers, '正常改名不得改变本轮成员或权限')
  }
  const waitingTransactions = (id, blocker) => query(`SELECT DISTINCT w.REQUESTING_ENGINE_TRANSACTION_ID
    FROM performance_schema.data_lock_waits w
    JOIN performance_schema.data_locks l ON l.ENGINE=w.ENGINE AND l.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID
    WHERE l.OBJECT_SCHEMA='collab_doc' AND l.OBJECT_NAME='document' AND l.INDEX_NAME='PRIMARY'
      AND l.LOCK_TYPE='RECORD' AND l.LOCK_DATA='${id}'
      ${blocker ? `AND w.BLOCKING_THREAD_ID=(SELECT THREAD_ID FROM performance_schema.threads WHERE PROCESSLIST_ID=${blocker})` : ''}
    ORDER BY w.REQUESTING_ENGINE_TRANSACTION_ID;`).split(/\r?\n/).filter(Boolean)
  const waitLocks = async (id, predicate, blocker) => {
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      const transactions = waitingTransactions(id, blocker)
      if (predicate(transactions)) return transactions
      await pause(50)
    }
    throw Error('30秒内未观测到要求的真实 document PRIMARY 事务等待队列')
  }
  const pending = promise => promise.then(value => ({ value }), error => ({ error }))
  for (const scenario of ['downgrade', 'remove']) {
    const title = `RenamePermission-${nonce}-${scenario}`
    const attempted = title + '-late-rename'
    const editorAllowed = title + '-editor-allowed'
    const ownerAllowed = title + '-owner-allowed'
    const cleanupTitles = [title, attempted, editorAllowed, ownerAllowed]
    let id, barrier, permissionRequest, renameRequest
    const controller = new AbortController()
    try {
      const document = await success(api(ports[0], owner.token, '/doc', 'POST', { title }))
      id = safeId(document.id)
      assertEmpty(id, [title]); assert.equal(members(id), '')
      await success(api(ports[0], owner.token, `/doc/${id}/collaborators`, 'POST', { username: credentials.username, permission: 2 }))
      assert.equal(members(id), `${viewerId}\t2`)
      await renameAllowed(ports[1], viewer.token, id, editorAllowed, `${viewerId}\t2`)
      await renameAllowed(ports[0], owner.token, id, title, `${viewerId}\t2`)
      console.log(`CONTROL ${scenario}: 编辑者正常改名200，所有者还原标题200，metadata/正文/revision0/历史0/编辑权限保持`)
      barrier = holdDocument({ mysqlId, id, cwd, env })
      const connectionId = await barrier.lock()
      permissionRequest = pending(api(ports[0], owner.token, `/doc/${id}/collaborators/${viewerId}`,
        scenario === 'downgrade' ? 'PUT' : 'DELETE', scenario === 'downgrade' ? { permission: 1 } : undefined, controller.signal))
      const first = await waitLocks(id, rows => rows.length === 1, connectionId)
      renameRequest = pending(api(ports[1], viewer.token, `/doc/${id}`, 'PUT', { title: attempted }, controller.signal))
      const both = await waitLocks(id, rows => rows.length === 2 && rows.includes(first[0]))
      console.log(`EVIDENCE ${scenario}: document=${id}, owner事务=${first[0]}, distinct PRIMARY等待事务=${both.join(',')}`)
      await barrier.release(true)
      barrier = null
      const [permission, rename] = await Promise.all([permissionRequest, renameRequest])
      if (permission.error) throw permission.error
      if (rename.error) throw rename.error
      const row = assertEmpty(id, [title, attempted])
      const actualMembers = members(id)
      console.log(`EVIDENCE ${scenario}: permissionHTTP=${permission.value.status}, renameHTTP=${rename.value.status}, renameCode=${rename.value.payload.code}, title=${JSON.stringify(row.title)}, members=${JSON.stringify(actualMembers)}, revision=0, emptyBodySHA256=${row.hash}, operations/receipts/snapshots=0`)
      assert.equal(permission.value.status, 200); assert.equal(permission.value.payload.code, 0)
      assert.equal(actualMembers, scenario === 'downgrade' ? `${viewerId}\t1` : '')
      assert.equal(rename.value.status, 403, '排队撤权后重命名必须按当前权限拒绝')
      assert.notEqual(rename.value.payload.code, 0)
      assert.equal(row.title, title, '撤权后不允许改标题')
      const expectedMembers = scenario === 'downgrade' ? `${viewerId}\t1` : ''
      await renameAllowed(ports[0], owner.token, id, ownerAllowed, expectedMembers)
      await renameAllowed(ports[0], owner.token, id, title, expectedMembers)
      console.log(`CONTROL ${scenario}: 撤权后所有者仍正常改名及还原200，metadata/正文/revision0/历史0/当前成员保持`)
      console.log(`PASS: ${scenario} 双后端真实锁队列，撤权先提交后重命名403，空正文及全部历史保持`)
    } catch (error) {
      failures.push(Error(`${scenario}: ${error.message}`))
      console.error(`FAIL: ${scenario}: ${error.message}`)
    } finally {
      try { if (barrier) await barrier.release(false) }
      finally {
        controller.abort()
        await Promise.all([permissionRequest, renameRequest].filter(Boolean))
      }
      if (id) {
        assertEmpty(id, cleanupTitles)
        const actualMembers = members(id)
        assert.ok(['', `${viewerId}\t1`, `${viewerId}\t2`].includes(actualMembers), '清理拒绝：发现非本轮唯一成员')
        if (actualMembers) await success(api(ports[0], owner.token, `/doc/${id}/collaborators/${viewerId}`, 'DELETE'))
        assert.equal(members(id), '')
        await success(api(ports[0], owner.token, `/doc/${id}`, 'DELETE'))
        assertEmpty(id, cleanupTitles, 1)
        console.log(`CLEANUP: ${scenario} 精确合成文档 ${id} 已移除本轮成员并软删除，正文/历史未删除`)
      }
    }
  }
  assert.equal(failures.length, 0, failures.map(error => error.message).join('; '))
}
