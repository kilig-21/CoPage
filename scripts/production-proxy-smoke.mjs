import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import https from 'node:https'

// 固定本轮验收的官方镜像摘要；不在验收中静默下载镜像或软件。
const image = 'nginx@sha256:0985e772fb9f729e6fa0980da05fca5d9c468e870eed43071545afa9d2e27d94'
const cwd = fileURLToPath(new URL('../', import.meta.url))

export async function runProxyCheck({ docker, source, username, password }) {
  const name = 'copage-proxy-qa-' + randomBytes(6).toString('hex')
  const directory = mkdtempSync(join(tmpdir(), 'copage-proxy-'))
  const files = ['qa.crt', 'qa.key', 'nginx.conf']
  let created = false
  let projectName
  try {
    docker(['image', 'inspect', image])
    const certificate = spawnSync(process.env.COPAGE_OPENSSL ?? 'openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,DNS:images.example.invalid',
      '-keyout', join(directory, 'qa.key'), '-out', join(directory, 'qa.crt'),
    ], { encoding: 'utf8' })
    assert.equal(certificate.status, 0, '需要已有 OpenSSL；可通过 COPAGE_OPENSSL 指定路径。不安装软件。')
    const stack = JSON.parse(source(['config', '--format', 'json']).stdout)
    assert.match(stack.name, /^copage-prod-qa-[a-f0-9]+$/)
    projectName = stack.name
    let template = readFileSync(new URL('../deploy/nginx/copage.conf.example', import.meta.url), 'utf8')
    template = template.replaceAll('api.example.invalid', 'localhost')
      .replaceAll('http://127.0.0.1:18080', 'http://backend:8080')
      .replaceAll('http://127.0.0.1:19000', 'http://minio:9000')
      .replaceAll(/\/etc\/letsencrypt\/live\/[^/]+\/fullchain.pem/g, '/etc/nginx/copage/qa.crt')
      .replaceAll(/\/etc\/letsencrypt\/live\/[^/]+\/privkey.pem/g, '/etc/nginx/copage/qa.key')
    writeFileSync(join(directory, 'nginx.conf'), 'events {}\nhttp {\n' + template + '\n}\n', { mode: 0o600 })
    const mount = directory + ':/etc/nginx/copage:ro'
    docker(['run', '--rm', '--pull', 'never', '--network', stack.networks.default.name,
      '-v', mount, image, 'nginx', '-t', '-c', '/etc/nginx/copage/nginx.conf'])
    docker(['run', '-d', '--pull', 'never', '--name', name, '--label', 'copage.qa=' + stack.name,
      '--network', stack.networks.default.name, '-p', '127.0.0.1::443', '-v', mount,
      image, 'nginx', '-g', 'daemon off;', '-c', '/etc/nginx/copage/nginx.conf'])
    created = true
    const address = docker(['port', name, '443/tcp']).stdout.trim()
    assert.match(address, /^127\.0\.0\.1:\d+$/)
    const port = address.split(':')[1]
    // NODE_EXTRA_CA_CERTS 仅传给这个子进程；验证测试证书，不关闭 TLS 校验。
    const client = spawnSync(process.execPath, ['scripts/production-proxy-smoke.mjs', '--client', port], {
      cwd, encoding: 'utf8', timeout: 90_000,
      env: { ...process.env, NODE_EXTRA_CA_CERTS: join(directory, 'qa.crt'),
        COPAGE_PROXY_USER: username, COPAGE_PROXY_PASSWORD: password },
    })
    assert.equal(client.status, 0, client.stderr)
    const summary = JSON.parse(client.stdout)
    const access = docker(['exec', name, 'cat', '/var/log/nginx/copage-access.log']).stdout
    const errors = docker(['logs', name]).stderr
    for (const log of [access, errors]) {
      assert.ok(!log.includes(summary.token) && !log.includes('token=') && !log.includes(password),
        '代理日志不得记录 JWT query 或密码')
    }
    assert.ok(access.includes(' /ws/collab 101 '), '必须保留不含 query 的 WS 升级证据')
    console.log('PASS: nginx -t；校验测试证书的 HTTPS/WSS 登录、协同/持久化读取与 ping；精确 CORS/WS 来源；图片 GET/HEAD、拒绝写入/桶列举/管理；11 MiB 限制；代理日志不含 token')
  } finally {
    if (created) {
      const label = docker(['inspect', '--format', '{{index .Config.Labels "copage.qa"}}', name]).stdout.trim()
      assert.equal(label, projectName, '清理前必须核对临时代理的项目归属')
      docker(['rm', '-f', name])
    }
    for (const file of files) {
      try { unlinkSync(join(directory, file)) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    rmdirSync(directory)
    console.log('临时反向代理、测试证书与配置已清理')
  }
}

async function checkClient(port) {
  const request = (path, { host = 'localhost', method = 'GET', body, headers = {} } = {}) =>
    new Promise((resolve, reject) => {
      const req = https.request({ hostname: '127.0.0.1', port, servername: host, path, method,
        ca: readFileSync(process.env.NODE_EXTRA_CA_CERTS),
        headers: { Host: host, ...headers }, timeout: 5000 }, response => {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }))
      })
      req.on('upgrade', (response, socket) => {
        socket.destroy()
        resolve({ status: response.statusCode, headers: response.headers })
      })
      req.on('timeout', () => req.destroy(new Error('HTTPS 验收超时')))
      req.on('error', reject)
      req.end(body)
    })
  // Node 子进程已信任临时证书，使用空 CA 证明没有关闭证书校验。
  const untrusted = new Promise((resolve, reject) => {
    const req = https.get({ hostname: '127.0.0.1', port, servername: 'localhost', ca: [], timeout: 5000 }, reject)
    req.on('error', resolve)
    req.on('timeout', () => req.destroy(new Error('证书反例超时')))
  })
  assert.match((await untrusted).code, /SELF_SIGNED|CERT/)
  await assert.rejects(request('/', { host: 'unconfigured.example.invalid' }), error =>
    ['EPROTO', 'ERR_SSL_TLSV1_UNRECOGNIZED_NAME'].includes(error.code)
      && /unrecognized name/i.test(error.message))
  const api = async (path, method = 'GET', body) => {
    const response = await request('/api' + path, { method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json' } })
    assert.equal(response.status, 200)
    const result = JSON.parse(response.body)
    assert.equal(result.code, 0)
    return result.data
  }
  let token
  assert.equal((await request('/api/doc/list')).status, 401)
  assert.equal((await request('/ws/collab')).status, 401)
  token = (await api('/auth/login', 'POST', { username: process.env.COPAGE_PROXY_USER, password: process.env.COPAGE_PROXY_PASSWORD })).token
  const doc = await api('/doc', 'POST', { title: 'HTTPS-WSS 验收 ' + randomUUID() })
  for (const [origin, status] of [['https://frontend.example.invalid', 200], ['https://untrusted.example.invalid', 403]]) {
    const preflight = await request('/api/doc/list', { method: 'OPTIONS', headers: {
      Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'Authorization',
    } })
    assert.equal(preflight.status, status)
    if (status === 200) assert.equal(preflight.headers['access-control-allow-origin'], origin)
    const upgrade = await request('/ws/collab?token=' + encodeURIComponent(token), { headers: {
      Origin: origin, Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
    } })
    assert.equal(upgrade.status, status === 200 ? 101 : 403)
  }
  const socket = new WebSocket(`wss://localhost:${port}/ws/collab?token=${encodeURIComponent(token)}`)
  const messages = []
  socket.addEventListener('message', event => messages.push(JSON.parse(event.data)))
  const wait = async predicate => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const found = messages.find(predicate)
      if (found) return found
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error('WSS 协同消息未到达')
  }
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WSS 握手超时')), 5000)
      socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WSS 握手失败')) }, { once: true })
    })
    const syncId = randomUUID()
    const clientId = randomUUID()
    socket.send(JSON.stringify({ type: 'join', docId: doc.id, clientId, lastRevision: 0, syncId }))
    assert.equal((await wait(m => m.type === 'sync' && m.syncId === syncId)).revision, 0)
    const opId = randomUUID()
    socket.send(JSON.stringify({ type: 'op', docId: doc.id, clientId, opId, baseRevision: 0, op: { ops: [{ insert: 'TLS 协同验收 ' }] } }))
    assert.equal((await wait(m => m.type === 'ack' && m.opId === opId)).revision, 1)
    socket.send(JSON.stringify({ type: 'ping' }))
    assert.equal((await wait(m => m.type === 'pong')).revision, 1)
    const saved = await api('/doc/' + doc.id)
    assert.equal(saved.revision, 1)
    assert.ok(JSON.stringify(saved.content).includes('TLS 协同验收'))
  } finally { socket.close() }

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4s0AAAAASUVORK5CYII=', 'base64')
  const boundary = 'copage' + randomBytes(16).toString('hex')
  const multipart = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="qa.png"\r\nContent-Type: image/png\r\n\r\n`), png, Buffer.from(`\r\n--${boundary}--\r\n`)])
  const upload = await request('/api/upload/image', { method: 'POST', body: multipart, headers: {
    Authorization: 'Bearer ' + token, 'Content-Type': 'multipart/form-data; boundary=' + boundary,
  } })
  assert.equal(upload.status, 200)
  const payload = JSON.parse(upload.body)
  assert.equal(payload.code, 0)
  const url = new URL(payload.data.url)
  assert.equal(url.origin, 'https://images.example.invalid')
  const publicImage = await request(url.pathname, { host: url.hostname })
  assert.equal(publicImage.status, 200)
  assert.deepEqual(publicImage.body, png)
  assert.equal((await request(url.pathname, { host: url.hostname, method: 'HEAD' })).status, 200)
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    assert.equal((await request(url.pathname, { host: url.hostname, method })).status, 403)
  }
  for (const path of ['/', '/collab', '/collab/?list-type=2', '/minio/health/live', '/api/doc/list']) {
    assert.equal((await request(path, { host: url.hostname })).status, 404, '图片入口应拒绝路径 ' + path)
  }
  assert.equal((await request('/api/upload/image', { method: 'POST', headers: { 'Content-Length': String(12 * 1024 * 1024) } })).status, 413)
  await api('/doc/' + doc.id, 'DELETE')
  // 仅回传给父进程用于检验日志；父进程不会输出这份 JSON。
  process.stdout.write(JSON.stringify({ token }))
}

if (process.argv[2] === '--client') {
  await checkClient(Number(process.argv[3]))
}
