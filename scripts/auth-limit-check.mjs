import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { setTimeout as pause } from 'node:timers/promises'

export async function runAuthLimitCheck({ ports, username, password }) {
  async function send(port, action, data, forwarded) {
    const response = await fetch(`http://127.0.0.1:${port}/api/auth/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(forwarded ? { 'X-Forwarded-For': forwarded } : {}) },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(5000),
    })
    return { status: response.status, retryAfter: Number(response.headers.get('Retry-After')), body: await response.json() }
  }

  const [first, peer] = ports
  const attempt = { username, password: randomBytes(16).toString('hex') }
  assert.equal((await send(first, 'login', attempt, '192.0.2.21')).status, 401)
  assert.equal((await send(first, 'login', attempt, '192.0.2.22')).status, 401)
  const locked = await send(first, 'login', attempt, '192.0.2.23')
  assert.equal(locked.status, 429)
  assert.equal(locked.body.code, 429)
  assert.match(locked.body.message, /登录失败次数过多/)
  assert.ok(locked.retryAfter > 0 && locked.retryAfter <= 3)
  assert.equal((await send(peer, 'login', { username, password })).status, 429)

  const other = { username: 'qa' + randomBytes(8).toString('hex'), password }
  assert.equal((await send(first, 'register', other)).status, 200)
  assert.equal((await send(peer, 'login', other)).status, 200)
  await pause(locked.retryAfter * 1000 + 250)
  assert.equal((await send(peer, 'login', { username, password })).status, 200)

  const registration = { username: 'qa' + randomBytes(8).toString('hex'), password }
  assert.equal((await send(first, 'register', registration)).status, 200)
  assert.equal((await send(peer, 'register', registration)).status, 400)
  const limited = await send(first, 'register', registration)
  assert.equal(limited.status, 429)
  assert.equal(limited.body.code, 429)
  assert.match(limited.body.message, /注册请求过于频繁/)
  assert.ok(limited.retryAfter > 0)
  let ipLimited = false
  for (let i = 0; i < 8; i++) {
    const result = await send(first, 'register', { username: 'qa' + randomBytes(8).toString('hex'), password })
    if (result.status === 429) {
      ipLimited = true
      break
    }
    assert.equal(result.status, 200)
  }
  assert.equal(ipLimited, true, '同来源的新账号也应受注册总请求上限控制')
  console.log('PASS: 双实例共享登录锁定与注册限流；伪造来源未影响计数，同 IP 其他账号可登录，锁定到期自动恢复')
}
