import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { runRecoveryCheck } from './production-recovery-smoke.mjs'
import { runProxyCheck } from './production-proxy-smoke.mjs'

const cwd = fileURLToPath(new URL('../', import.meta.url))
const secret = () => randomBytes(32).toString('hex')
const settings = {
  PROD_MYSQL_ROOT_PASSWORD: secret(),
  PROD_MYSQL_PASSWORD: secret(),
  PROD_REDIS_PASSWORD: secret(),
  PROD_RABBITMQ_PASSWORD: secret(),
  PROD_MINIO_ROOT_USER: 'qa-' + randomBytes(8).toString('hex'),
  PROD_MINIO_ROOT_PASSWORD: secret(),
  PROD_JWT_SECRET: secret(),
  PROD_FRONTEND_ORIGIN: 'https://frontend.example.invalid',
  PROD_MINIO_PUBLIC_ENDPOINT: 'https://images.example.invalid',
  PROD_BACKEND_PORT: '18080',
  PROD_MINIO_PORT: '19000',
}
const env = { ...process.env, ...settings }
delete env.COMPOSE_PROJECT_NAME
const base = ['compose', '--env-file', '.env.production.example', '-f', 'compose.production.yml']

function docker(args, { input, customEnv = env, allowFailure = false, binary = false } = {}) {
  const result = spawnSync('docker', args, { cwd, env: customEnv, input, encoding: binary ? undefined : 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (result.error) throw result.error
  // Compose config 的 stdout 可能包含随机测试凭据，不把它写入日志。
  if (!allowFailure && result.status !== 0) {
    throw new Error(`Docker ${args[0]} 执行失败（退出码 ${result.status}）：${result.stderr}`)
  }
  return result
}

const config = JSON.parse(docker([...base, 'config', '--format', 'json']).stdout)
assert.equal(config.name, 'copage-production')
assert.equal(config.services.backend.environment.SPRING_PROFILES_ACTIVE, 'prod')
assert.equal(config.services.backend.environment.MYSQL_USER, 'copage')
assert.notEqual(config.services.mysql.environment.MYSQL_PASSWORD, config.services.mysql.environment.MYSQL_ROOT_PASSWORD)
assert.equal(config.services.backend.environment.REDIS_PASSWORD, config.services.redis.environment.REDIS_PASSWORD)
for (const [name, service] of Object.entries(config.services)) {
  for (const port of service.ports ?? []) {
    assert.ok(['backend', 'minio'].includes(name), `${name} 不应发布内部端口`)
    assert.equal(port.host_ip, '127.0.0.1', `${name} 必须只绑定回环地址`)
  }
}
assert.equal(config.services.backend.ports.length, 1)
assert.equal(config.services.minio.ports.length, 1)
const sqlMounts = config.services.mysql.volumes.filter(v => v.target.startsWith('/docker-entrypoint-initdb.d/'))
assert.equal(sqlMounts.length, 1)
assert.ok(sqlMounts[0].source.endsWith('schema.sql'))
for (const key of Object.keys(settings).filter(key => !key.endsWith('_PORT'))) {
  const missing = docker([...base, 'config', '--quiet'], { customEnv: { ...env, [key]: '' }, allowFailure: true })
  assert.notEqual(missing.status, 0, `缺少 ${key} 时配置必须拒绝运行`)
}
console.log('PASS: 生产凭据必填、prod profile、非 root 数据库账号、回环端口、独立无演示账号的建表挂载')

const recoverySmoke = process.argv.includes('--recovery-smoke')
const proxySmoke = process.argv.includes('--proxy-smoke')
const expirySmoke = process.argv.includes('--session-expiry-smoke')
const fullSmoke = process.argv.includes('--full-smoke') || recoverySmoke || proxySmoke || expirySmoke
if (process.argv.includes('--smoke') || fullSmoke) {
  // 随机项目名只属于本次验收，不触及开发或实际生产项目的数据卷。
  const project = 'copage-prod-qa-' + randomBytes(6).toString('hex')
  const qa = [...base, '-p', project]
  // 动态分配回环端口，防止覆盖已有本机服务。
  const qaEnv = { ...env, PROD_BACKEND_PORT: '0', PROD_MINIO_PORT: '0' }
  const qaDocker = (args, options = {}) => docker([...qa, ...args], { ...options, customEnv: qaEnv })
  const sql = (statement, root = false, allowFailure = false) => qaDocker([
    'exec', '-T', 'mysql', 'sh', '-ec',
    root
      ? 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -N -D collab_doc'
      : 'MYSQL_PWD="$MYSQL_PASSWORD" mysql -h127.0.0.1 -u"$MYSQL_USER" -N -D collab_doc',
  ], { input: statement, allowFailure })
  try {
    if (fullSmoke) {
      qaDocker(['build', 'backend'])
      qaDocker(['up', '-d', '--no-build', '--wait', '--wait-timeout', '150', '--scale', 'backend=2'])
    } else {
      qaDocker(['up', '-d', '--wait', '--wait-timeout', '90', 'mysql', 'redis'])
    }
    const initial = sql('SELECT COUNT(*) FROM user; SELECT CURRENT_USER(); SHOW TABLES;').stdout.trim().split(/\r?\n/)
    assert.equal(initial[0], '0', '生产初始化不得创建演示账号')
    assert.ok(initial[1].startsWith('copage@'), '应用必须使用独立数据库账号')
    for (const table of ['user', 'document', 'doc_operation', 'doc_operation_receipt', 'doc_snapshot', 'doc_collaborator', 'doc_history_boundary', 'doc_named_version']) {
      assert.ok(initial.slice(2).includes(table), `缺少表 ${table}`)
    }
    assert.notEqual(sql('SELECT * FROM mysql.user;', false, true).status, 0, '应用账号不应读取系统账号表')
    const redisNoAuth = qaDocker(['exec', '-T', 'redis', 'redis-cli', 'ping']).stdout
    assert.ok(redisNoAuth.includes('NOAUTH'), 'Redis 无凭据请求必须拒绝')
    const redisAuth = qaDocker(['exec', '-T', 'redis', 'sh', '-ec', 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli ping']).stdout.trim()
    assert.equal(redisAuth, 'PONG')
    console.log('PASS: 全新 MySQL 无演示账号、八张表齐全、数据库权限隔离、Redis 认证')
    if (fullSmoke) {
      const ports = [1, 2].map(index => {
        const address = qaDocker(['port', '--index', String(index), 'backend', '8080']).stdout.trim()
        assert.match(address, /^127\.0\.0\.1:\d+$/)
        return Number(address.split(':')[1])
      })
      assert.notEqual(ports[0], ports[1])
      for (const port of ports) {
        const deadline = Date.now() + 60_000
        let ready = false
        while (Date.now() < deadline) {
          try {
            const response = await fetch(`http://127.0.0.1:${port}/api/doc/list`, { signal: AbortSignal.timeout(2000) })
            assert.equal(response.status, 401)
            ready = true
            break
          } catch {
            await new Promise(resolve => setTimeout(resolve, 500))
          }
        }
        assert.ok(ready, 'prod 后端未在期限内就绪')
      }
      const username = 'qa' + randomBytes(6).toString('hex')
      const password = secret()
      const registration = await fetch(`http://127.0.0.1:${ports[0]}/api/auth/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, nickname: '临时部署验收账号' }),
        signal: AbortSignal.timeout(5000),
      })
      assert.equal(registration.status, 200)
      assert.equal((await registration.json()).code, 0)
      const smoke = spawnSync(process.execPath, ['scripts/collab-smoke.mjs'], {
        cwd, encoding: 'utf8', timeout: 120_000,
        env: { ...process.env, COPAGE_SMOKE_PORT_A: String(ports[0]), COPAGE_SMOKE_PORT_B: String(ports[1]),
          COPAGE_SMOKE_USER: username, COPAGE_SMOKE_PASSWORD: password },
      })
      assert.equal(smoke.status, 0, smoke.stderr)
      console.log(smoke.stdout.trim())
      assert.equal(sql("SELECT COUNT(*) FROM user WHERE username IN ('testA','testB');").stdout.trim(), '0')
      console.log('PASS: 两个 prod 后端均就绪，独立注册账号跨实例协同通过，未创建演示账号')
      if (expirySmoke) {
        const expiry = spawnSync(process.execPath, ['scripts/session-expiry-smoke.mjs'], {
          cwd, encoding: 'utf8', timeout: 120_000,
          env: { ...process.env, COPAGE_SMOKE_PORT_A: String(ports[0]), COPAGE_SMOKE_PORT_B: String(ports[1]),
            COPAGE_SMOKE_JWT_SECRET: qaEnv.PROD_JWT_SECRET },
        })
        assert.equal(expiry.status, 0, expiry.stderr)
        console.log(expiry.stdout.trim())
      }
      if (proxySmoke) {
        await runProxyCheck({ docker, source: qaDocker, username, password })
      }
      if (recoverySmoke) {
        await runRecoveryCheck({ docker, base, env: qaEnv, source: qaDocker, sql, port: ports[0], username, password })
      }
    } else {
      // 在临时库单独应用开发种子，核对拆分后本地演示仍可初始化。
      sql(readFileSync(new URL('../backend/src/main/resources/db/demo-users.sql', import.meta.url), 'utf8'), true)
      const seeded = sql('SELECT username,HEX(nickname) FROM user ORDER BY username;').stdout.trim().split(/\r?\n/)
      assert.deepEqual(seeded, ['testA\tE6B58BE8AF95E794A8E688B72041', 'testB\tE6B58BE8AF95E794A8E688B72042'])
      console.log('PASS: 开发种子账号及昵称正确')
    }
  } catch (error) {
    // 先保留本次隔离测试的诊断，再清理临时栈；日志不直接打印，避免泄露合成凭据。
    const diagnostics = mkdtempSync(join(tmpdir(), 'copage-production-failure-'))
    const logs = qaDocker(['logs', '--no-color', 'backend'], { allowFailure: true })
    writeFileSync(join(diagnostics, 'backend.log'), logs.stdout + logs.stderr, { mode: 0o600 })
    console.error(`隔离验收失败的后端诊断已保留：${diagnostics}`)
    throw error
  } finally {
    const ids = qaDocker(['ps', '-aq']).stdout.trim().split(/\s+/).filter(Boolean)
    for (const id of ids) {
      const label = docker(['inspect', '--format', '{{index .Config.Labels "com.docker.compose.project"}}', id]).stdout.trim()
      assert.equal(label, project, '清理前必须确认测试容器项目归属')
    }
    qaDocker(['down', '--volumes', '--remove-orphans'])
    console.log('临时验收容器、网络和数据卷已清理')
  }
}
