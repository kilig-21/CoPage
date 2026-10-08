import assert from 'node:assert/strict'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openRecoveryChannel } from './recovery-channel.mjs'

// 仅由生产配置验收脚本调用，输入是该脚本新建的随机临时项目。
export async function runRecoveryCheck({ docker, base, env, source, sql, port, username, password }) {
  const restoredProject = 'copage-recovery-qa-' + randomBytes(6).toString('hex')
  const destination = (args, options = {}) => docker([...base, '-p', restoredProject, ...args], { ...options, customEnv: env })
  const backupDir = mkdtempSync(join(tmpdir(), 'copage-recovery-backup-'))
  const sqlFile = join(backupDir, 'mysql.sql')
  const imageFile = join(backupDir, 'minio-data.tar.gz')
  let verified = false
  let socket
  let token
  const origin = p => `http://127.0.0.1:${p}`
  const sha256 = data => createHash('sha256').update(data).digest('hex')
  const api = async (p, path, method = 'GET', body) => {
    const response = await fetch(origin(p) + '/api' + path, {
      method, signal: AbortSignal.timeout(5000),
      headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    assert.equal(response.status, 200, `${path} HTTP ${response.status}`)
    const payload = await response.json()
    assert.equal(payload.code, 0, payload.message)
    return payload.data
  }
  const connect = (p, docId, clientId, lastRevision = 0, phase = 'source') => openRecoveryChannel({
    url: `ws://127.0.0.1:${p}/ws/collab?token=${encodeURIComponent(token)}`,
    docId, clientId, lastRevision, phase,
  })
  const readSql = (stack, query) => stack([
    'exec', '-T', 'mysql', 'sh', '-ec',
    'MYSQL_PWD="$MYSQL_PASSWORD" mysql -h127.0.0.1 -u"$MYSQL_USER" -N -D collab_doc',
  ], { input: query }).stdout.trim()
  const assertProject = (container, project) => {
    const label = docker(['inspect', '--format', '{{index .Config.Labels "com.docker.compose.project"}}', container]).stdout.trim()
    assert.equal(label, project, '恢复或清理前必须核对资源项目归属')
  }
  try {
    token = (await api(port, '/auth/login', 'POST', { username, password })).token
    const revokedToken = token
    const oldPassword = password
    const currentPassword = randomBytes(24).toString('hex')
    await api(port, '/account/password', 'POST', { currentPassword: password, newPassword: currentPassword })
    password = currentPassword
    token = (await api(port, '/auth/login', 'POST', { username, password })).token
    assert.equal(JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).credentialVersion, 1)
    const title = '恢复演练-' + randomUUID()
    const document = await api(port, '/doc', 'POST', { title })
    const docId = document.id
    const viewer = { username: 'view' + randomBytes(6).toString('hex'), password: randomBytes(32).toString('hex') }
    const outsider = { username: 'other' + randomBytes(6).toString('hex'), password: randomBytes(32).toString('hex') }
    await api(port, '/auth/register', 'POST', viewer)
    await api(port, '/auth/register', 'POST', outsider)
    sql(`INSERT INTO doc_collaborator (doc_id,user_id,permission) SELECT ${docId},id,1 FROM user WHERE username='${viewer.username}';`)
    // 生成的 1×1 PNG，仅用于比对恢复前后字节，不依赖个人文件。
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4s0AAAAASUVORK5CYII=', 'base64')
    const form = new FormData()
    form.append('file', new File([image], 'recovery.png', { type: 'image/png' }))
    const upload = await fetch(origin(port) + '/api/upload/image', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: form, signal: AbortSignal.timeout(5000),
    })
    assert.equal(upload.status, 200)
    const uploaded = await upload.json()
    assert.equal(uploaded.code, 0)
    const publicUrl = uploaded.data.url
    assert.equal(new URL(publicUrl).origin, 'https://images.example.invalid')
    const publicPath = new URL(publicUrl).pathname
    const clientId = randomUUID()
    const firstId = randomUUID()
    const bodyMarker = 'recoverybody' + randomBytes(8).toString('hex')
    const firstOp = { ops: [{ insert: '恢复验收 ' + bodyMarker + ' ' }, { insert: { image: publicUrl } }] }
    socket = await connect(port, docId, clientId)
    assert.equal((await socket.submit(firstId, 0, firstOp)).revision, 1)
    for (let index = 1; index < 20; index++) {
      const ack = await socket.submit(randomUUID(), index, { ops: [{ insert: String.fromCharCode(65 + index) }] })
      assert.equal(ack.revision, index + 1)
    }
    socket.ws.close()
    socket = null
    const original = await api(port, '/doc/' + docId)
    assert.equal(original.revision, 20)
    const snapshotDeadline = Date.now() + 60_000
    while (Date.now() < snapshotDeadline && Number(readSql(source, `SELECT COUNT(*) FROM doc_snapshot WHERE doc_id=${docId};`)) === 0) {
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    assert.equal(readSql(source, `SELECT MAX(revision) FROM doc_snapshot WHERE doc_id=${docId};`), '20')
    const query = `SELECT revision,HEX(op) FROM doc_operation WHERE doc_id=${docId} ORDER BY revision;
      SELECT user_id,client_id,op_id,revision,request_hash FROM doc_operation_receipt WHERE doc_id=${docId} ORDER BY revision;
      SELECT revision,HEX(content) FROM doc_snapshot WHERE doc_id=${docId} ORDER BY revision;
      SELECT user_id,permission FROM doc_collaborator WHERE doc_id=${docId} ORDER BY user_id;`
    const durableHistory = readSql(source, query)

    // 对应部署说明的维护窗口：先停写入，再导出 SQL，停 MinIO 后只读归档。
    source(['stop', 'backend'])
    const dump = source(['exec', '-T', 'mysql', 'sh', '-ec',
      'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysqldump -uroot --single-transaction --routines --events --triggers collab_doc']).stdout
    assert.ok(dump.includes('CREATE TABLE') && dump.includes(title), '数据库备份必须包含真实测试数据')
    writeFileSync(sqlFile, dump, { mode: 0o600 })
    source(['stop', 'minio'])
    const sourceMinio = source(['ps', '-a', '-q', 'minio']).stdout.trim()
    const sourceProject = source(['config', '--format', 'json']).stdout
    assertProject(sourceMinio, JSON.parse(sourceProject).name)
    const archive = docker(['run', '--rm', '--network', 'none', '--volumes-from', sourceMinio + ':ro',
      'redis:7.4.1-alpine', 'sh', '-ec', 'tar -czf - -C /data .'], { binary: true }).stdout
    assert.ok(archive.length > 0)
    writeFileSync(imageFile, archive, { mode: 0o600 })
    source(['stop'])
    console.log('PASS: 停止写入后导出 MySQL SQL 和 MinIO 只读数据卷备份')

    // 全新随机项目，先仅启动数据库；应用尚未启动，不会与 SQL 导入并发写入。
    destination(['up', '-d', '--wait', '--wait-timeout', '90', 'mysql'])
    assert.equal(readSql(destination, 'SELECT COUNT(*) FROM user; SELECT COUNT(*) FROM document;'), '0\n0')
    destination(['exec', '-T', 'mysql', 'sh', '-ec', 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -D collab_doc'],
      { input: readFileSync(sqlFile, 'utf8') })
    destination(['create', 'minio'])
    const targetMinio = destination(['ps', '-a', '-q', 'minio']).stdout.trim()
    assertProject(targetMinio, restoredProject)
    docker(['run', '--rm', '-i', '--network', 'none', '--volumes-from', targetMinio,
      'redis:7.4.1-alpine', 'sh', '-ec', 'test -z "$(ls -A /data)"; tar -xzf - -C /data'], { input: readFileSync(imageFile) })
    // 先让基础服务就绪并确认 ES 没有业务索引，再启动应用，排除复用旧索引。
    destination(['up', '-d', '--no-build', '--wait', '--wait-timeout', '150',
      'mysql', 'redis', 'rabbitmq', 'elasticsearch', 'minio', 'minio-init'])
    const emptyIndex = destination(['exec', '-T', 'elasticsearch', 'curl', '-sS',
      '-o', '/dev/null', '-w', '%{http_code}', 'http://localhost:9200/collab_documents']).stdout.trim()
    assert.equal(emptyIndex, '404', '恢复目标的 ES 必须从不存在的业务索引开始')
    destination(['up', '-d', '--no-build', '--wait', '--wait-timeout', '150', 'backend'])
    const getPort = service => {
      const address = destination(['port', service, service === 'backend' ? '8080' : '9000']).stdout.trim()
      assert.match(address, /^127\.0\.0\.1:\d+$/)
      return Number(address.split(':')[1])
    }
    const restoredPort = getPort('backend')
    const minioPort = getPort('minio')
    const deadline = Date.now() + 60_000
    let loggedIn = false
    while (Date.now() < deadline) {
      try {
        token = (await api(restoredPort, '/auth/login', 'POST', { username, password })).token
        loggedIn = true
        break
      } catch {
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    }
    assert.ok(loggedIn, '恢复后的账号必须可登录')
    assert.equal(JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).credentialVersion, 1)
    const oldSession = await fetch(origin(restoredPort) + '/api/account/me', {
      headers: { Authorization: 'Bearer ' + revokedToken }, signal: AbortSignal.timeout(5000),
    })
    assert.equal(oldSession.status, 401, '恢复备份不得复活已撤销的旧令牌')
    const oldLogin = await fetch(origin(restoredPort) + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: oldPassword }), signal: AbortSignal.timeout(5000),
    })
    assert.equal(oldLogin.status, 401, '恢复后旧密码仍不得登录')
    await api(restoredPort, '/account/me')
    console.log('PASS: 已改密码和凭据版本1完整恢复，新密码可登录，旧密码与旧令牌仍拒绝')
    const restored = await api(restoredPort, '/doc/' + docId)
    assert.equal(restored.title, original.title)
    assert.equal(restored.revision, original.revision)
    assert.deepEqual(restored.content, original.content)
    assert.equal(readSql(destination, query), durableHistory, '操作历史、幂等收据和快照必须完整恢复')
    const searchPath = q => '/search?q=' + encodeURIComponent(q)
    const assertSearchHit = result => {
      assert.equal(result.total, 1)
      assert.deepEqual(result.list.map(hit => hit.id), [docId])
      assert.equal(result.list[0].title, title)
    }
    // 此前只读取恢复数据，没有产生编辑或索引通知；命中来自 MySQL 定时重建。
    const searchDeadline = Date.now() + 70_000
    let searchResult
    while (Date.now() < searchDeadline) {
      searchResult = await api(restoredPort, searchPath(title))
      if (searchResult.total === 1) break
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    assertSearchHit(searchResult)
    assertSearchHit(await api(restoredPort, searchPath(bodyMarker)))
    const recoveredImage = await fetch(origin(minioPort) + publicPath, { signal: AbortSignal.timeout(5000) })
    assert.equal(recoveredImage.status, 200)
    assert.equal(sha256(Buffer.from(await recoveredImage.arrayBuffer())), sha256(image))
    token = (await api(restoredPort, '/auth/login', 'POST', viewer)).token
    assert.equal((await api(restoredPort, '/doc/' + docId)).permission, 1)
    assertSearchHit(await api(restoredPort, searchPath(title)))
    assertSearchHit(await api(restoredPort, searchPath(bodyMarker)))
    socket = await connect(restoredPort, docId, randomUUID(), 20, 'restored-readonly')
    const forbidden = await socket.submit(randomUUID(), 20, { ops: [{ insert: '不应提交' }] }, 'error')
    assert.equal(forbidden.code, 403, '恢复后的只读协作者不得提交操作')
    socket.ws.close()
    socket = null
    token = (await api(restoredPort, '/auth/login', 'POST', outsider)).token
    const denied = await fetch(origin(restoredPort) + '/api/doc/' + docId, {
      headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(5000),
    })
    assert.equal(denied.status, 403, '恢复后无权账号仍不得访问文档')
    for (const q of [title, bodyMarker]) {
      const hidden = await api(restoredPort, searchPath(q))
      assert.equal(hidden.total, 0, '无权账号不得获知搜索命中数量')
      assert.deepEqual(hidden.list, [], '无权账号不得读取搜索摘要')
    }
    console.log('PASS: 空 ES 从 MySQL 自动重建标题/正文索引；所有者及只读协作者可检索，无权账号零命中且无摘要')
    token = (await api(restoredPort, '/auth/login', 'POST', { username, password })).token
    socket = await connect(restoredPort, docId, clientId, 18, 'restored-owner')
    assert.equal(socket.sync.revision, 20)
    assert.equal(socket.sync.historyComplete, true)
    assert.deepEqual(socket.sync.history.map(entry => entry.revision), [19, 20])
    assert.equal((await socket.submit(firstId, 0, firstOp)).revision, 1, '恢复后重复原 opId 应命中收据')
    assert.equal((await api(restoredPort, '/doc/' + docId)).revision, 20)
    assert.equal((await socket.submit(randomUUID(), 20, { ops: [{ insert: '恢复后继续编辑 ' }] })).revision, 21)
    assert.equal((await api(restoredPort, '/doc/' + docId)).revision, 21)
    verified = true
    console.log('PASS: 新卷恢复登录、正文/revision、20 条历史及收据、revision=20 快照、图片 SHA-256、只读/无权边界；冷 Redis 追赶、去重及继续编辑到 revision=21')
  } finally {
    socket?.ws.close()
    const ids = destination(['ps', '-aq']).stdout.trim().split(/\s+/).filter(Boolean)
    for (const id of ids) assertProject(id, restoredProject)
    if (!verified) {
      try {
        const diagnostics = destination(['logs', '--no-color', 'backend'], { allowFailure: true })
        writeFileSync(join(backupDir, 'restored-backend.log'), diagnostics.stdout + diagnostics.stderr, { mode: 0o600 })
      } catch { console.error('恢复目标诊断未能保存；继续清理已核对归属的临时项目') }
    }
    destination(['down', '--volumes', '--remove-orphans'])
    if (verified) {
      unlinkSync(sqlFile)
      unlinkSync(imageFile)
      rmdirSync(backupDir)
      console.log('恢复目标临时项目及合成备份文件已清理')
    } else {
      console.error(`恢复验收失败；合成备份与恢复目标诊断保留在：${backupDir}`)
    }
  }
}
