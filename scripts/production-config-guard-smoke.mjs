import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'

export async function runProductionConfigGuardCheck({ source, env, port, username, password }) {
  const oldDemoSecret = 'change-this-local-development-secret-key-please'
  for (const [name, override, hidden] of [
    ['JWT_SECRET', 'JWT_SECRET=' + oldDemoSecret, oldDemoSecret],
    ['REDIS_PASSWORD', 'REDIS_PASSWORD=', null],
    ['MINIO_ENDPOINT', 'MINIO_ENDPOINT=https://user:fixture-secret@bad host', 'fixture-secret'],
  ]) {
    const failure = source(['run', '--rm', '--no-deps', '-T', '-e', 'SPRING_PROFILES_ACTIVE=qa',
      '-e', override, 'backend'], { allowFailure: true })
    const logs = failure.stdout + failure.stderr
    assert.notEqual(failure.status, 0, 'non-prod profile must reject invalid startup config')
    assert.ok(logs.includes('CoPage') && logs.includes(name), 'startup must name the invalid setting')
    assert.ok(!hidden || !logs.includes(hidden), 'startup must redact rejected values')
    assert.ok(!logs.includes('HikariPool'), 'startup checks must run before opening the database')
  }
  console.log('PASS: 非 prod profile 在连接数据库前拒绝旧 JWT、缺失 Redis 密码和畸形 MinIO 地址，日志不含值')

  async function login(origin) {
    const response = await fetch(origin + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(8000),
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.code, 0)
    assert.ok(typeof body.data?.token === 'string')
    return body.data.token
  }

  const authorize = (origin, token) => fetch(origin + '/api/account/me', {
    headers: { Authorization: 'Bearer ' + token },
    signal: AbortSignal.timeout(8000),
  })
  const oldOrigin = 'http://127.0.0.1:' + port
  const oldToken = await login(oldOrigin)
  assert.equal((await authorize(oldOrigin, oldToken)).status, 200)

  source(['stop', 'backend'])
  source(['up', '-d', '--no-build', '--no-deps', '--force-recreate', '--wait', '--wait-timeout', '90',
    '--scale', 'backend=2', 'backend'], {
    customEnv: { ...env, PROD_JWT_SECRET: randomBytes(32).toString('hex') },
  })
  const newOrigins = [1, 2].map(index => 'http://' +
    source(['port', '--index', String(index), 'backend', '8080']).stdout.trim())
  const newToken = await login(newOrigins[0])
  for (const origin of newOrigins) {
    assert.equal((await authorize(origin, oldToken)).status, 401)
    assert.equal((await authorize(origin, newToken)).status, 200)
  }
  console.log('PASS: JWT 轮换后双实例拒绝旧会话，新会话在两实例均有效')
}
