import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const safeId = value => { assert.ok(Number.isSafeInteger(value) && value > 0, '隔离对象编号无效'); return value }
const same = (actual, expected, message) => assert.ok(JSON.stringify(actual) === JSON.stringify(expected), message)

// 只保持本轮已核对 MySQL 容器中的独立事务；stdout 标记证明锁已取得/释放。
function holdDocument({ mysqlId, docId, cwd, env }) {
  const marker = 'editbarrier' + randomBytes(12).toString('hex')
  const child = spawn('docker', ['exec', '-i', mysqlId, 'sh', '-ec',
    'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql --default-character-set=utf8mb4 -uroot --batch --raw --skip-column-names --unbuffered -D collab_doc'],
  { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  let output = '', ended = false, failure, released = false
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', value => { output += value; if (output.length > 65536) failure = Error('隔离行锁会话输出超限') })
  child.stderr.on('data', () => {}) // 诊断不输出凭据、连接串或原始 SQL。
  child.on('error', () => { failure = Error('隔离行锁会话无法启动') })
  child.on('close', code => { ended = true; if (code !== 0) failure = Error('隔离行锁会话异常退出') })
  child.stdin.on('error', () => { failure = Error('隔离行锁会话输入关闭') })
  const waitFor = async condition => {
    const deadline = Date.now() + 30000
    while (!condition()) {
      if (failure) throw failure
      assert.ok(!ended, '隔离行锁会话提前退出')
      assert.ok(Date.now() < deadline, '隔离行锁标记等待超时')
      await pause(25)
    }
  }
  return {
    async lock() {
      child.stdin.write('START TRANSACTION; SELECT id FROM document WHERE id=' + docId +
        " FOR UPDATE; SELECT '" + marker + "',CONNECTION_ID();\n")
      await waitFor(() => new RegExp(marker + '\\t\\d+\\r?\\n').test(output))
      return safeId(Number(output.split(marker + '\t')[1].split(/\r?\n/)[0]))
    },
    async release(commit = false) {
      if (!released && !ended && !failure) {
        child.stdin.write((commit ? 'COMMIT' : 'ROLLBACK') + "; SELECT '" + marker + "released';\n")
        try { await waitFor(() => output.includes(marker + 'released')); released = true }
        finally { child.stdin.end() }
      } else if (!ended) child.stdin.end()
      const deadline = Date.now() + 10000
      while (!ended && Date.now() < deadline) await pause(25)
      if (!ended) { child.kill(); throw Error('隔离行锁会话退出超时；需外层清理随机栈') }
      if (!released && failure) throw failure
    },
  }
}

// 记录消息及关闭码；拒绝必须有403或明确撤权通知，不能以断开/超时替代。
async function openChannel({ port, token, docId, clientId, lastRevision }) {
  let ws
  try { ws = new WebSocket('ws://127.0.0.1:' + port + '/ws/collab?token=' + encodeURIComponent(token)) }
  catch { throw Error('隔离 WS 创建失败') }
  const messages = []
  let opened = false, closed = false, closeCode, failure
  ws.addEventListener('open', () => { opened = true })
  ws.addEventListener('close', event => { closed = true; closeCode = event.code })
  ws.addEventListener('error', () => { failure = Error('隔离 WS 连接出错') })
  ws.addEventListener('message', event => {
    try {
      const message = JSON.parse(event.data)
      assert.ok(message && typeof message === 'object' && !Array.isArray(message))
      messages.push(message)
    } catch { failure = Error('隔离 WS 消息无效') }
  })
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      const found = predicate()
      if (found) return found
      if (failure) throw failure
      if (closed) throw Error(label + '：WS 已关闭(code=' + closeCode + ')')
      await pause(25)
    }
    throw Error(label + '：等待超时')
  }
  const send = value => {
    assert.ok(opened && !closed && ws.readyState === 1, '隔离 WS 不可发送')
    ws.send(JSON.stringify(value))
  }
  try {
    await waitFor(() => opened, '握手')
    const syncId = randomUUID()
    send({ type: 'join', docId, clientId, lastRevision, syncId })
    const sync = await waitFor(() => messages.find(message =>
      (message.type === 'sync' && message.syncId === syncId) || message.type === 'error'), '加入')
    assert.equal(sync.type, 'sync', '隔离 WS 加入必须成功')
    assert.equal(sync.docId, docId)
    return {
      messages, sync, clientId,
      sendOperation(opId, baseRevision, op) {
        const after = messages.length
        send({ type: 'op', docId, clientId, opId, baseRevision, op })
        return { opId, after }
      },
      async operationResult(ticket, allowRevokedClose = false) {
        return waitFor(() => {
          const recent = messages.slice(ticket.after)
          const response = recent.find(message =>
            (message.type === 'ack' && message.opId === ticket.opId) || message.type === 'error')
          if (response) return response
          if (allowRevokedClose && closed && closeCode === 1008 &&
              recent.some(message => message.type === 'permission' && message.docId === docId && message.permission === 0)) {
            return { type: 'revoked-close', code: 403, closeCode }
          }
          return null
        }, '操作结果')
      },
      async submit(opId, baseRevision, op) {
        const response = await this.operationResult(this.sendOperation(opId, baseRevision, op))
        assert.equal(response.type, 'ack', '合法操作必须获得 ACK')
        assert.equal(response.docId, docId)
        assert.equal(response.clientId, clientId)
        return response
      },
      async close() {
        try { ws.close() } catch {}
        const deadline = Date.now() + 2000
        while (!closed && Date.now() < deadline) await pause(25)
      },
    }
  } catch (error) {
    try { ws.close() } catch {}
    throw error
  }
}

export async function runDocumentEditPermissionCheck({ docker, source, sql, ports, cwd, env = process.env }) {
  const config = JSON.parse(source(['config', '--format', 'json']).stdout)
  assert.match(config.name, /^copage-prod-qa-[0-9a-f]{12}$/, '编辑权限验收仅接受本轮随机隔离生产项目')
  assert.equal(ports.length, 2)
  assert.notEqual(ports[0], ports[1])
  for (let index = 0; index < ports.length; index++) {
    assert.ok(Number.isSafeInteger(ports[index]) && ports[index] > 0 && ports[index] <= 65535)
    assert.equal(source(['port', '--index', String(index + 1), 'backend', '8080']).stdout.trim(),
      '127.0.0.1:' + ports[index], 'WS/API 端口必须属于本轮隔离后端')
  }
  const mysqlId = source(['ps', '-q', 'mysql']).stdout.trim()
  const backendIds = source(['ps', '-q', 'backend']).stdout.trim().split(/\s+/).filter(Boolean)
  assert.equal(backendIds.length, 2)
  for (const id of [mysqlId, ...backendIds]) {
    assert.match(id, /^[0-9a-f]{12,64}$/)
    assert.equal(docker(['inspect', '--format', '{{index .Config.Labels "com.docker.compose.project"}}', id]).stdout.trim(),
      config.name, '业务动作前必须核对隔离容器归属')
  }
  const query = statement => {
    const result = sql(statement, true)
    assert.equal(result.status, 0, '隔离数据库核对失败')
    return result.stdout.trim()
  }
  const api = async (port, token, path, method = 'GET', body, signal) => {
    const response = await fetch('http://127.0.0.1:' + port + '/api' + path, {
      method, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000),
      headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: response.status, payload: await response.json() }
  }
  const success = async promise => {
    const result = await promise
    assert.equal(result.status, 200, '隔离 HTTP 应成功')
    assert.equal(result.payload.code, 0, '隔离 HTTP 业务结果应成功')
    return result.payload.data
  }
  const nonce = randomBytes(12).toString('hex')
  const account = async (prefix, port) => {
    const credentials = { username: prefix + nonce, password: randomBytes(32).toString('hex') }
    await success(api(port, null, '/auth/register', 'POST', credentials))
    const session = await success(api(port, null, '/auth/login', 'POST', credentials))
    const profile = await success(api(port, session.token, '/account/me'))
    return { username: credentials.username, token: session.token, id: safeId(profile.id) }
  }
  const owner = await account('editowner', ports[0])
  const editor = await account('editeditor', ports[1])
  assert.notEqual(owner.id, editor.id)

  const waitingTransactions = (docId, blocker) => query(
    'SELECT DISTINCT w.REQUESTING_ENGINE_TRANSACTION_ID FROM performance_schema.data_lock_waits w ' +
    'JOIN performance_schema.data_locks l ON l.ENGINE=w.ENGINE AND l.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID ' +
    "WHERE l.OBJECT_SCHEMA='collab_doc' AND l.OBJECT_NAME='document' AND l.INDEX_NAME='PRIMARY' " +
    "AND l.LOCK_TYPE='RECORD' AND l.LOCK_DATA='" + docId + "' " +
    (blocker ? 'AND w.BLOCKING_THREAD_ID=(SELECT THREAD_ID FROM performance_schema.threads WHERE PROCESSLIST_ID=' + blocker + ') ' : '') +
    'ORDER BY w.REQUESTING_ENGINE_TRANSACTION_ID;').split(/\r?\n/).filter(Boolean)
  const waitLocks = async (docId, predicate, blocker) => {
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      const transactions = waitingTransactions(docId, blocker)
      if (predicate(transactions)) return transactions
      await pause(50)
    }
    throw Error('30秒内未观测到所需真实 document PRIMARY 等待事务')
  }
  const waitTransactionEnded = async transaction => {
    assert.match(transaction, /^[0-9]+$/, '隔离操作事务编号无效')
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      if (query("SELECT COUNT(*) FROM information_schema.innodb_trx WHERE trx_id='" + transaction + "';") === '0') return
      await pause(50)
    }
    throw Error('已观测的排队操作事务未在30秒内结束，不能认定零写入')
  }
  const readState = (docId, title) => {
    const row = query('SELECT HEX(title),HEX(content),revision,owner_id,is_deleted FROM document WHERE id=' + docId + ';').split('\t')
    assert.equal(row.length, 5)
    assert.equal(Buffer.from(row[0], 'hex').toString('utf8'), title, '合成文档精确标题不符')
    assert.equal(Number(row[3]), owner.id, '合成文档所有者不符')
    assert.equal(row[4], '0', '合成文档必须活动')
    const count = table => Number(query('SELECT COUNT(*) FROM ' + table + ' WHERE doc_id=' + docId + ';'))
    return {
      content: row[1], revision: Number(row[2]),
      operations: query('SELECT revision,user_id,HEX(op) FROM doc_operation WHERE doc_id=' + docId + ' ORDER BY revision;'),
      receipts: query('SELECT user_id,client_id,op_id,revision,request_hash FROM doc_operation_receipt WHERE doc_id=' + docId +
        ' ORDER BY user_id,client_id,op_id;'),
      operationCount: count('doc_operation'), receiptCount: count('doc_operation_receipt'),
      snapshotCount: count('doc_snapshot'), namedCount: count('doc_named_version'),
      boundaryCount: count('doc_history_boundary'), associationCount: count('project_document'),
      creationCount: count('doc_creation_receipt'),
    }
  }
  const assertText = (state, expectedText, expectedRevision) => {
    same(JSON.parse(Buffer.from(state.content, 'hex').toString('utf8')), { ops: [{ insert: expectedText }] },
      '合成完整 Delta 必须与已确认操作精确一致')
    assert.equal(state.revision, expectedRevision)
    assert.equal(state.operationCount, expectedRevision)
    assert.equal(state.receiptCount, expectedRevision)
    assert.equal(state.associationCount, 0)
    assert.equal(state.creationCount, 0)
    assert.equal(state.namedCount, 0)
    assert.equal(state.boundaryCount, 0)
  }
  const members = docId => query('SELECT user_id,permission FROM doc_collaborator WHERE doc_id=' + docId + ' ORDER BY user_id;')
  const pending = promise => promise.then(value => ({ value }), error => ({ error }))
  const failures = []
  for (const scenario of ['downgrade', 'remove']) {
    const title = 'EditPermission-' + nonce + '-' + scenario
    const ownerSeed = 'owner-' + scenario + '|'
    const editorSeed = 'editor-' + scenario + '|'
    const lateText = 'denied-' + scenario + '|'
    const afterText = 'owner-after-' + scenario + '|'
    const ownerSeedId = randomUUID(), editorSeedId = randomUUID(), lateId = randomUUID(), afterId = randomUUID()
    const controller = new AbortController()
    let docId, barrier, permissionRequest, ownerChannel, editorChannel
    try {
      docId = safeId((await success(api(ports[0], owner.token, '/doc', 'POST', { title }))).id)
      const initial = readState(docId, title)
      assertText(initial, '\n', 0)
      assert.equal(members(docId), '')
      await success(api(ports[0], owner.token, '/doc/' + docId + '/collaborators', 'POST',
        { username: editor.username, permission: 2 }))
      assert.equal(members(docId), editor.id + '\t2')
      ownerChannel = await openChannel({ port: ports[0], token: owner.token, docId, clientId: randomUUID(), lastRevision: 0 })
      assert.equal(ownerChannel.sync.revision, 0)
      const ownerOp = { ops: [{ insert: ownerSeed }] }
      assert.equal((await ownerChannel.submit(ownerSeedId, 0, ownerOp)).revision, 1)
      const ownerSaved = readState(docId, title)
      assertText(ownerSaved, ownerSeed + '\n', 1)
      assert.equal((await ownerChannel.submit(ownerSeedId, 0, ownerOp)).revision, 1)
      same(readState(docId, title), ownerSaved, '合法拥有者旧 ACK 重放不能再次落库')
      editorChannel = await openChannel({ port: ports[1], token: editor.token, docId, clientId: randomUUID(), lastRevision: 0 })
      assert.equal(editorChannel.sync.revision, 1)
      const editorOp = { ops: [{ insert: editorSeed }] }
      assert.equal((await editorChannel.submit(editorSeedId, 1, editorOp)).revision, 2)
      const before = readState(docId, title)
      assertText(before, editorSeed + ownerSeed + '\n', 2)
      assert.equal((await editorChannel.submit(editorSeedId, 1, editorOp)).revision, 2)
      same(readState(docId, title), before, '合法编辑者旧 ACK 重放不能再次落库')
      console.log('CONTROL ' + scenario + ': document=' + docId + ', 正常双身份编辑至2，两个原ACK去重均保持2/2/2')

      barrier = holdDocument({ mysqlId, docId, cwd, env })
      const blocker = await barrier.lock()
      permissionRequest = pending(api(ports[0], owner.token, '/doc/' + docId + '/collaborators/' + editor.id,
        scenario === 'downgrade' ? 'PUT' : 'DELETE', scenario === 'downgrade' ? { permission: 1 } : undefined, controller.signal))
      const first = await waitLocks(docId, rows => rows.length === 1, blocker)
      const ticket = editorChannel.sendOperation(lateId, 2, { ops: [{ insert: lateText }] })
      const both = await waitLocks(docId, rows => rows.length === 2 && rows.includes(first[0]))
      console.log('EVIDENCE ' + scenario + ': document=' + docId + ', permissionTxn=' + first[0] +
        ', distinctPrimaryWaiters=' + both.join(','))
      await barrier.release(true)
      barrier = null
      const permission = await permissionRequest
      if (permission.error) throw permission.error
      assert.equal(permission.value.status, 200, '先排队的权限更新必须成功')
      assert.equal(permission.value.payload.code, 0)
      assert.equal(members(docId), scenario === 'downgrade' ? editor.id + '\t1' : '')
      // 撤权通知可能先关闭WS；必须等实际观测到的编辑事务结束再检查零写入。
      const editTransaction = both.find(transaction => transaction !== first[0])
      await waitTransactionEnded(editTransaction)
      const result = await editorChannel.operationResult(ticket, scenario === 'remove')
      const after = readState(docId, title)
      const lateReceipts = Number(query('SELECT COUNT(*) FROM doc_operation_receipt WHERE doc_id=' + docId +
        ' AND user_id=' + editor.id + " AND op_id='" + lateId + "';"))
      console.log('EVIDENCE ' + scenario + ': permissionHTTP=' + permission.value.status + ', WS=' + result.type +
        ', code=' + result.code + (result.closeCode ? ', close=' + result.closeCode : '') +
        ', revision=' + after.revision + ', operations=' + after.operationCount + ', receipts=' + after.receiptCount +
        ', deniedReceipt=' + lateReceipts)
      assert.notEqual(result.type, 'ack', '权限先提交后排队编辑不得获得 ACK')
      assert.ok(result.type === 'error' || (scenario === 'remove' && result.type === 'revoked-close'), '必须明确拒绝本次编辑')
      assert.equal(result.code, 403, '降权后排队编辑应按当前权限拒绝')
      assert.equal(lateReceipts, 0, '被拒操作不得生成收据')
      same(after, before, '权限先提交后正文/revision/操作/收据/历史必须保持')
      assert.ok(!editorChannel.messages.slice(ticket.after).some(message => message.type === 'ack' && message.opId === lateId),
        '本次被拒编辑不得出现迟到 ACK')

      assert.equal((await ownerChannel.submit(ownerSeedId, 0, ownerOp)).revision, 1)
      same(readState(docId, title), before, '权限变化后拥有者原合法 ACK 仍应去重')
      const afterOp = { ops: [{ insert: afterText }] }
      assert.equal((await ownerChannel.submit(afterId, 2, afterOp)).revision, 3)
      const ownerContinued = readState(docId, title)
      assertText(ownerContinued, afterText + editorSeed + ownerSeed + '\n', 3)
      assert.equal((await ownerChannel.submit(afterId, 2, afterOp)).revision, 3)
      same(readState(docId, title), ownerContinued, '拥有者继续编辑后的原 ACK 重放不得重复')
      assert.equal(members(docId), scenario === 'downgrade' ? editor.id + '\t1' : '')
      console.log('PASS ' + scenario + ': 权限真实先排队提交，越权正文零写入，拥有者继续至3/3/3且原ACK去重')
    } catch (error) {
      failures.push(scenario + ': ' + error.message)
      console.error('FAIL ' + scenario + ': ' + error.message)
    } finally {
      controller.abort()
      try { if (barrier) await barrier.release(false) }
      finally {
        await Promise.all([permissionRequest, ownerChannel?.close(), editorChannel?.close()].filter(Boolean))
      }
      // 不逐篇删除历史或猜测失败正文；外层会核对整个随机栈归属后统一清理自己的卷。
      if (docId) console.log('FIXTURE ' + scenario + ': document=' + docId + ', 保留在本轮随机栈，等待外层归属守卫清理')
    }
  }
  assert.equal(failures.length, 0, failures.join('; '))
}